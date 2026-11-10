import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ServerEvents } from '@sharkord/shared';
import { initTest } from '../../__tests__/helpers';
import { loadMockedPlugins, resetPluginMocks } from '../../__tests__/mocks';
import { pluginManager } from '../../plugins';
import { pubsub } from '../../utils/pubsub';

describe('plugin settings transitions', () => {
	beforeAll(loadMockedPlugins);
	beforeEach(resetPluginMocks);

	test('preserves plugins on unrelated saves and publishes commands on disable and enable', async () => {
		await pluginManager.loadPlugins();
		const commands = pluginManager.getCommands();
		expect(Object.keys(commands).length).toBeGreaterThan(0);
		const { caller } = await initTest(1);
		const changes: unknown[] = [];
		const subscription = pubsub
			.subscribe(ServerEvents.PLUGIN_COMMANDS_CHANGE)
			.subscribe({ next: (value) => changes.push(value) });
		try {
			await caller.others.updateSettings({ storageUploadEnabled: true });
			expect(pluginManager.getCommands()).toEqual(commands);
			expect(changes).toEqual([]);
			await caller.others.updateSettings({ enablePlugins: false });
			expect(pluginManager.getCommands()).toEqual({});
			expect(changes).toEqual([{}]);
			await caller.others.updateSettings({ enablePlugins: true });
			expect(pluginManager.getCommands()).toEqual(commands);
			expect(changes).toEqual([{}, commands]);
		} finally {
			subscription.unsubscribe();
			await pluginManager.unloadPlugins();
		}
	});
});
