import { describe, expect, it, mock } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import type { AppData, Producer } from 'mediasoup-client/types';
import { ScreenAudioMode, type TDesktopBridge } from '@/runtime/types';
import { createScreenShareController, mountScreenShareController } from '../screen-share-controller';
import { createCapture, createProducer, createVideoFixture, deferred, flush } from './video-controller-fixture';

const createScreenFixture = () => {
	const f = createVideoFixture();
	const audio = {
		stop: mock(async () => {}),
		awaitTeardown: mock(async () => {}),
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
describe('screen-video production owner', () => {
	it('notifies video start before deferred optional audio, using unchanged display constraints', async () => {
		const f = createScreenFixture();
		const pending = deferred<'none'>();
		f.audio.start.mockImplementation(() => pending.promise);
		const c = createScreenShareController(f.deps);
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
		const c = createScreenShareController(f.deps);
		await c.start();
		c.stop();
		expect(capture.videoTrack.readyState).toBe('ended');
		expect(capture.audioTrack?.readyState).toBe('live');
		expect(f.audio.adoptDisplayAudio).toHaveBeenCalledWith(capture.stream);
		expect(f.audio.stop).toHaveBeenCalledTimes(1);
	});
	it('detaches and republishes surviving capture while retaining its ended handler', async () => {
		const f = createScreenFixture();
		const c = createScreenShareController(f.deps);
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
		const c = createScreenShareController(f.deps);
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
		const c = createScreenShareController(f.deps);
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
		const c = createScreenShareController({ ...f.deps, getDesktopBridge: () => bridge });
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
		const c = createScreenShareController({
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
