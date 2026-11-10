import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { loadMockedPlugins, resetPluginMocks } from '../../__tests__/mocks';
import { VoiceRuntime } from '../../runtimes/voice';
import { pluginManager } from '..';
import { eventBus } from '../event-bus';

const pluginId = 'plugin-registers-then-throws';

describe('failed plugin resource cleanup', () => {
	beforeAll(loadMockedPlugins);
	beforeEach(async () => {
		await resetPluginMocks();
		Reflect.set(globalThis, 'failedPluginEventCount', 0);
	});
	afterEach(async () => {
		await pluginManager.unload(pluginId);
		Reflect.deleteProperty(globalThis, 'failedPluginEventCount');
		Reflect.deleteProperty(globalThis, 'failedPluginCreateStreams');
		Reflect.deleteProperty(globalThis, 'failedPluginKeepContext');
		Reflect.deleteProperty(globalThis, 'failedPluginContext');
	});

	test('ignores registrations from a context left over after a failed load', async () => {
		Reflect.set(globalThis, 'failedPluginKeepContext', true);
		await pluginManager.togglePlugin(pluginId, true);

		const staleContext: unknown = Reflect.get(globalThis, 'failedPluginContext');
		if (typeof staleContext !== 'object' || staleContext === null) throw new Error('Missing plugin context');
		const commands: unknown = Reflect.get(staleContext, 'commands');
		const events: unknown = Reflect.get(staleContext, 'events');
		const settings: unknown = Reflect.get(staleContext, 'settings');
		if (typeof commands !== 'object' || commands === null) throw new Error('Missing commands API');
		if (typeof events !== 'object' || events === null) throw new Error('Missing events API');
		if (typeof settings !== 'object' || settings === null) throw new Error('Missing settings API');

		Reflect.apply(Reflect.get(commands, 'register'), commands, [{ name: 'late-command', executes: () => 'late' }]);
		Reflect.apply(Reflect.get(events, 'on'), events, ['message:created', () => {}]);

		expect(pluginManager.hasCommand(pluginId, 'late-command')).toBe(false);
		expect(eventBus.hasPlugin(pluginId)).toBe(false);
		expect(() => Reflect.apply(Reflect.get(settings, 'register'), settings, [[]])).toThrow('is not loaded');
	});

	test('releases registrations on every failed load while retaining the error', async () => {
		await pluginManager.togglePlugin(pluginId, true);
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt > 0) await pluginManager.load(pluginId);
			expect(pluginManager.getCommands()[pluginId]).toBeUndefined();
			expect(pluginManager.hasCommand(pluginId, 'leaked-command')).toBe(false);
			await eventBus.emit('message:created', { messageId: 1, channelId: 1, userId: 1, content: 'test' });
			expect(Reflect.get(globalThis, 'failedPluginEventCount')).toBe(0);
			expect(eventBus.hasPlugin(pluginId)).toBe(false);
			expect((await pluginManager.getPluginInfo(pluginId)).loadError).toContain(
				'Intentional error after registering resources',
			);
			expect(await pluginManager.getPluginSettings(pluginId)).toEqual({ definitions: [], values: {} });
		}
	});

	test('removes remaining streams and forgets handles already removed by the plugin', async () => {
		const runtime = new VoiceRuntime(2);
		const removeStream = spyOn(runtime, 'removeExternalStream');
		Reflect.set(globalThis, 'failedPluginCreateStreams', true);
		try {
			await pluginManager.togglePlugin(pluginId, true);
			expect(runtime.getState().externalStreams).toEqual({});
			expect(removeStream).toHaveBeenCalledTimes(2);
			await pluginManager.unload(pluginId);
			expect(removeStream).toHaveBeenCalledTimes(2);
		} finally {
			removeStream.mockRestore();
			await runtime.destroy();
		}
	});
});
