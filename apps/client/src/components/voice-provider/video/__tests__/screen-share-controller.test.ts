import { afterEach, describe, expect, it, mock } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import type { AppData, Producer } from 'mediasoup-client/types';
import { ScreenAudioMode, type TDesktopBridge } from '@/runtime/types';
import {
	createCapture,
	createProducer,
	createVideoFixture,
	deferred,
	flush,
} from '../../__tests__/video-controller-fixture';
import { createScreenShareController, mountScreenShareController } from '../screen-share-controller';

const createScreenFixture = () => {
	const f = createVideoFixture();
	const audio = {
		stop: mock(async () => {}),
		awaitTeardown: mock(async () => {}),
		discardDisplayAudio: mock((_stream: MediaStream) => {}),
		adoptDisplayAudio: mock((_stream: MediaStream) => {}),
		start: mock(async (_options: { displayStream: MediaStream }) => 'none' as const),
	};
	const deps = {
		...f.deps,
		shareAudio: audio,
		getDesktopBridge: (): TDesktopBridge | undefined => undefined,
		requestSelection: mock(async () => null),
		warning: mock((_message: string) => {}),
		setInterval: (handler: () => void, ms: number) => {
			const timer = setInterval(handler, ms);
			timer.unref();
			return timer;
		},
		clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
		now: () => Date.now(),
	};
	return { ...f, deps, audio };
};
const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});
const createMountedScreenShare = (...args: Parameters<typeof createScreenShareController>) => {
	const controller = createScreenShareController(...args);
	disposers.push(mountScreenShareController(controller));
	return controller;
};
describe('screen-video production owner', () => {
	it('polls only published capture, retains the guard during detach and releases it on stop or track end', async () => {
		const f = createScreenFixture();
		const setInterval = mock(f.deps.setInterval);
		const clearInterval = mock(f.deps.clearInterval);
		const c = createMountedScreenShare({ ...f.deps, setInterval, clearInterval });
		expect(setInterval).not.toHaveBeenCalled();
		const pending = deferred<Producer<AppData>>();
		f.publications.push(pending.promise);
		const start = c.start();
		await flush();
		expect(setInterval).not.toHaveBeenCalled();
		pending.resolve(createProducer('first', f.captures[0]?.videoTrack));
		await start;
		expect(setInterval).toHaveBeenCalledTimes(1);
		c.detachProducer();
		expect(clearInterval).not.toHaveBeenCalled();
		await c.republish();
		expect(setInterval).toHaveBeenCalledTimes(1);
		c.stop();
		expect(clearInterval).toHaveBeenCalledTimes(1);
		await c.start();
		expect(setInterval).toHaveBeenCalledTimes(2);
		f.captures[1]?.end();
		expect(clearInterval).toHaveBeenCalledTimes(2);
	});
	it('notifies video start before deferred optional audio, using unchanged display constraints', async () => {
		const f = createScreenFixture();
		const pending = deferred<'none'>();
		f.audio.start.mockImplementation(() => pending.promise);
		const c = createMountedScreenShare(f.deps);
		const started = mock(() => {});
		expect(f.acquire).not.toHaveBeenCalled();
		const start = c.start(undefined, { onVideoTrackStarted: started });
		await flush();
		expect(started).toHaveBeenCalledTimes(1);
		expect(c.isLive()).toBe(true);
		expect(f.produce.mock.calls[0]?.[0]).toMatchObject({ stopTracks: false, appData: { kind: StreamKind.SCREEN } });
		expect(f.acquire.mock.calls[0]?.[0]).toMatchObject({
			audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
		});
		pending.resolve('none');
		await start;
		c.stop();
		expect(f.captures[0]?.videoTrack.readyState).toBe('ended');
	});
	it('stops only video and delegates audio to its owner for a mixed display stream', async () => {
		const f = createScreenFixture();
		const capture = createCapture(true);
		f.acquisitions.push(Promise.resolve(capture.stream));
		const c = createMountedScreenShare(f.deps);
		await c.start();
		c.stop();
		expect(capture.videoTrack.readyState).toBe('ended');
		expect(capture.audioTrack?.readyState).toBe('live');
		expect(f.audio.adoptDisplayAudio).toHaveBeenCalledWith(capture.stream);
		expect(f.audio.stop).toHaveBeenCalledTimes(1);
	});
	it('detaches and republishes surviving capture while retaining its ended handler', async () => {
		const f = createScreenFixture();
		const c = createMountedScreenShare(f.deps);
		const ended = mock(() => {});
		await c.start(undefined, { onVideoTrackEnded: ended });
		const capture = f.captures[0];
		c.detachProducer();
		expect(capture?.videoTrack.readyState).toBe('live');
		expect(f.audio.stop).not.toHaveBeenCalled();
		await c.republish();
		expect(f.acquire).toHaveBeenCalledTimes(1);
		capture?.end();
		expect(ended).toHaveBeenCalledTimes(1);
		expect(f.audio.stop).toHaveBeenCalledTimes(1);
		expect(c.getStream()).toBeUndefined();
	});
	it('retains capture after failed republish and stops it on lifecycle cleanup', async () => {
		const f = createScreenFixture();
		const c = createMountedScreenShare(f.deps);
		const unmount = mountScreenShareController(c);
		await c.start();
		c.detachProducer();
		f.publications.push(Promise.reject(new Error('failed republish')));
		await expect(c.republish()).rejects.toThrow('failed republish');
		expect(f.captures[0]?.videoTrack.readyState).toBe('live');
		expect(f.audio.stop).not.toHaveBeenCalled();
		unmount();
		expect(f.captures[0]?.videoTrack.readyState).toBe('ended');
	});
	it('rejects stale transport completion and delegates adopted audio cleanup on publication failure', async () => {
		const f = createScreenFixture();
		const pending = deferred<Producer<AppData>>();
		f.publications.push(pending.promise);
		const c = createMountedScreenShare(f.deps);
		const start = c.start();
		await flush();
		f.replaceTransport();
		const late = createProducer('late');
		pending.resolve(late);
		await expect(start).rejects.toThrow();
		expect(late.closed).toBe(true);
		expect(f.captures[0]?.videoTrack.readyState).toBe('ended');
		expect(f.audio.stop).toHaveBeenCalledTimes(1);
	});
	it('preserves desktop selection, effective app-audio mode and system-picker reset', async () => {
		const f = createScreenFixture();
		const prepare = mock(async () => ({ effectiveMode: ScreenAudioMode.APP, warning: 'mode changed' }));
		const reset = mock(async () => {});
		const bridge = { prepareScreenShare: prepare, resetScreenSharePicker: reset } as unknown as TDesktopBridge;
		const c = createMountedScreenShare({ ...f.deps, getDesktopBridge: () => bridge });
		const selection = {
			sourceId: 'window:42',
			audioMode: ScreenAudioMode.APP,
			appAudioTargetId: 'app:42',
			useSystemPicker: true,
		};
		await c.start(selection);
		expect(prepare).toHaveBeenCalledWith(selection);
		expect(reset).toHaveBeenCalledTimes(1);
		expect(f.deps.warning).toHaveBeenCalledWith('mode changed');
		expect(f.acquire.mock.calls[0]?.[0]).toMatchObject({ audio: false });
		expect(f.audio.start).toHaveBeenCalledWith({
			displayStream: f.captures[0]?.stream,
			desktopBridge: bridge,
			captureInput: { sourceId: 'window:42', appAudioTargetId: 'app:42' },
			audioMode: ScreenAudioMode.APP,
		});
		c.stop();
	});
	it('opens selection with committed audio settings and a lazy capability/source loader', async () => {
		const f = createScreenFixture();
		const bridge = {
			listShareSources: mock(async () => []),
			getCapabilities: mock(async () => ({})),
		} as unknown as TDesktopBridge;
		let loaded = false;
		const c = createMountedScreenShare({
			...f.deps,
			getDesktopBridge: () => bridge,
			requestSelection: async (input) => {
				expect(input.defaultAudioMode).toBe(ScreenAudioMode.NONE);
				const data = await input.loadData();
				expect(data.sources).toEqual([]);
				loaded = true;
				return null;
			},
		});
		f.setDevices({ ...f.getDevices(), screenAudioMode: ScreenAudioMode.NONE });
		expect(await c.requestSelection()).toBeNull();
		expect(loaded).toBe(true);
		expect(f.acquire).not.toHaveBeenCalled();
		c.stop();
	});
});

describe('screen startup boundary fencing', () => {
	for (const phase of ['teardown', 'preparation', 'capabilities', 'optional audio'] as const) {
		it.each(['stop', 'supersession', 'cleanup'] as const)(`fences %s during ${phase}`, async (action) => {
			const f = createScreenFixture();
			const pending = deferred<void>();
			const bridge = {
				prepareScreenShare: async () => {
					if (phase === 'preparation') await pending.promise;
					return { requestedMode: ScreenAudioMode.SYSTEM, effectiveMode: ScreenAudioMode.SYSTEM };
				},
				getCapabilities: async () => {
					if (phase === 'capabilities') await pending.promise;
					return {
						platform: 'linux',
						perAppAudio: 'unsupported',
						systemAudio: 'supported',
						globalPushKeybinds: 'supported',
						issues: [],
						notes: [],
					};
				},
			} as unknown as TDesktopBridge;
			if (phase === 'teardown') f.audio.awaitTeardown.mockImplementationOnce(() => pending.promise);
			if (phase === 'optional audio')
				f.audio.start.mockImplementationOnce(async () => {
					await pending.promise;
					return 'none';
				});
			const c = createMountedScreenShare({ ...f.deps, getDesktopBridge: () => bridge });
			const started = mock(() => {});
			const start = c.start(
				{ sourceId: 'screen:1', audioMode: ScreenAudioMode.SYSTEM },
				{ onVideoTrackStarted: started },
			);
			const result = start.then(
				() => 'started',
				() => 'superseded',
			);
			await flush();
			if (action === 'stop') c.stop();
			else if (action === 'cleanup') c.deactivate();
			else {
				// The successor uses the ordinary browser path so its own platform lookup
				// is independent of the held predecessor's preparation/capability result.
				f.setDevices({ ...f.getDevices(), screenAudioMode: ScreenAudioMode.NONE });
				await c.start();
			}
			const replacement = action === 'supersession' ? c.getProducer() : undefined;
			const audioStops = f.audio.stop.mock.calls.length;
			pending.resolve();
			expect(await result).toBe('superseded');
			expect(f.audio.stop.mock.calls.length).toBe(audioStops);
			if (phase === 'optional audio') expect(started).toHaveBeenCalledTimes(1);
			else expect(started).not.toHaveBeenCalled();
			if (replacement) {
				expect(c.getProducer()).toBe(replacement);
				expect(c.isLive()).toBe(true);
			} else {
				expect(c.getStream()).toBeUndefined();
				expect(c.getProducer()).toBeUndefined();
			}
		});
	}
	it('does not start optional audio when the early video notification stops capture', async () => {
		const f = createScreenFixture();
		const c = createMountedScreenShare(f.deps);
		await expect(c.start(undefined, { onVideoTrackStarted: c.stop })).rejects.toThrow();
		expect(f.audio.start).not.toHaveBeenCalled();
		expect(c.getProducer()).toBeUndefined();
		expect(f.captures[0]?.videoTrack.readyState).toBe('ended');
	});
	it('discards a stale picker selection after stop without acquiring media', async () => {
		const f = createScreenFixture();
		const pending = deferred<{ sourceId: string; audioMode: ScreenAudioMode } | null>();
		const c = createMountedScreenShare({ ...f.deps, requestSelection: () => pending.promise });
		const selection = c.requestSelection();
		c.stop();
		pending.resolve({ sourceId: 'screen:1', audioMode: ScreenAudioMode.NONE });
		expect(await selection).toBeNull();
		expect(f.acquire).not.toHaveBeenCalled();
	});
});
