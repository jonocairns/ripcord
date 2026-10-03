import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { AppData, Producer } from 'mediasoup-client/types';
import { Resolution, VideoCodecPreference } from '@/types';
import { createScreenShareController, mountScreenShareController } from '../screen-share-controller';
import { createWebcamController, mountWebcamController } from '../webcam-controller';
import { createCapture, createProducer, createVideoFixture, deferred, flush } from './video-controller-fixture';

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});
const fixture = (kind: 'webcam' | 'screen') => {
	const f = createVideoFixture();
	const audio = {
		stop: mock(async () => {}),
		awaitTeardown: mock(async () => {}),
		adoptDisplayAudio: mock((_stream: MediaStream) => {}),
		discardDisplayAudio: mock((_stream: MediaStream) => {}),
		start: mock(async (_options: { displayStream: MediaStream }) => 'none' as const),
	};
	const c =
		kind === 'webcam'
			? createWebcamController(f.deps)
			: createScreenShareController({
					...f.deps,
					shareAudio: audio,
					getDesktopBridge: () => undefined,
					requestSelection: async () => null,
					warning: () => {},
					now: () => 0,
					setInterval: (handler, delayMs) => {
						const timer = setInterval(handler, delayMs);
						timer.unref();
						return timer;
					},
					clearInterval,
				});
	c.activate();
	const dispose = () => c.deactivate();
	disposers.push(dispose);
	return { ...f, c, audio, dispose };
};
for (const kind of ['webcam', 'screen'] as const) {
	describe(`${kind} production lifecycle races`, () => {
		for (const phase of ['acquisition', 'publication', 'sender configuration'] as const) {
			it.each(['stop', 'supersession', 'cleanup'] as const)(`fences %s during deferred ${phase}`, async (action) => {
				const f = fixture(kind);
				const capture = createCapture(true);
				const acquisition = deferred<MediaStream>();
				const publication = deferred<Producer<AppData>>();
				const senderCompletion = deferred<void>();
				const sender = {
					getParameters: () => ({ encodings: [{}] }),
					setParameters: () => senderCompletion.promise,
				} as unknown as RTCRtpSender;
				const late = createProducer('late', capture.videoTrack, phase === 'sender configuration' ? sender : undefined);
				f.acquisitions.push(phase === 'acquisition' ? acquisition.promise : Promise.resolve(capture.stream));
				if (phase === 'publication') f.publications.push(publication.promise);
				if (phase === 'sender configuration') f.publications.push(Promise.resolve(late));
				const start = f.c.start();
				const outcome = start.then(
					() => 'started',
					() => 'superseded',
				);
				await flush();
				let replacement: Producer<AppData> | undefined;
				if (action === 'stop') f.c.stop();
				else if (action === 'cleanup') f.dispose();
				else {
					await f.c.start();
					replacement = f.c.getProducer();
					expect(replacement).toBeDefined();
				}
				acquisition.resolve(capture.stream);
				publication.resolve(late);
				senderCompletion.resolve();
				expect(await outcome).toBe('superseded');
				expect(capture.videoTrack.readyState).toBe('ended');
				if (phase !== 'acquisition') {
					expect(late.closed).toBe(true);
					expect(f.closeProducer).toHaveBeenCalledWith('late');
				}
				if (kind === 'screen') expect(f.audio.discardDisplayAudio).toHaveBeenCalledWith(capture.stream);
				else expect(capture.audioTrack?.readyState).toBe('live');
				if (replacement) {
					expect(f.c.getProducer()).toBe(replacement);
					expect(f.c.isLive()).toBe(true);
				} else {
					expect(f.c.getProducer()).toBeUndefined();
					expect(f.c.getStream()).toBeUndefined();
				}
			});
		}
		it('snapshots acquisition constraints but reads current settings at video publication', async () => {
			const f = fixture(kind);
			const pending = deferred<MediaStream>();
			const capture = createCapture(false, {});
			const initial = f.getDevices();
			f.acquisitions.push(pending.promise);
			const start = f.c.start();
			await flush();
			f.setCapabilities({
				codecs: [{ kind: 'video', mimeType: 'video/VP9', clockRate: 90000, preferredPayloadType: 98 }],
			});
			f.setDevices({
				...initial,
				videoCodec: VideoCodecPreference.VP9,
				webcamResolution: Resolution['1080p'],
				screenResolution: Resolution['1080p'],
				webcamFramerate: 60,
				screenFramerate: 60,
			});
			pending.resolve(capture.stream);
			await start;
			expect(f.acquire.mock.calls[0]?.[0]).toMatchObject({
				video: { frameRate: kind === 'webcam' ? initial.webcamFramerate : initial.screenFramerate },
			});
			expect(f.produce.mock.calls[0]?.[0].codec?.mimeType).toBe('video/VP9');
			expect(f.produce.mock.calls[0]?.[0].encodings?.[0]?.maxBitrate).toBeGreaterThan(2_500_000);
		});
		it('rejects a transport replaced during sender configuration and closes its server allocation', async () => {
			const f = fixture(kind);
			const completion = deferred<void>();
			const sender = {
				getParameters: () => ({ encodings: [{}] }),
				setParameters: () => completion.promise,
			} as unknown as RTCRtpSender;
			const late = createProducer('stale-config', undefined, sender);
			f.publications.push(Promise.resolve(late));
			const result = f.c.start().then(
				() => 'started',
				() => 'superseded',
			);
			await flush();
			f.replaceTransport();
			completion.resolve();
			expect(await result).toBe('superseded');
			expect(late.closed).toBe(true);
			expect(f.closeProducer).toHaveBeenCalledWith('stale-config');
			expect(f.c.getProducer()).toBeUndefined();
		});

		it('stops a fresh capture after publication failure without leaving a producer or snapshot', async () => {
			const f = fixture(kind);
			f.publications.push(Promise.reject(new Error('publication failed')));
			await expect(f.c.start()).rejects.toThrow('publication failed');
			expect(f.captures[0]?.videoTrack.readyState).toBe('ended');
			expect(f.c.getProducer()).toBeUndefined();
			expect(f.c.getStream()).toBeUndefined();
		});
		it('does not clean up a successor when old publication rejects after replacement', async () => {
			const f = fixture(kind);
			const pending = deferred<Producer<AppData>>();
			f.publications.push(pending.promise);
			const start = f.c.start().catch(() => {});
			await flush();
			await f.c.start();
			const replacement = f.c.getProducer();
			f.audio.stop.mockClear();
			pending.reject(new Error('old publication failed'));
			await start;
			expect(f.c.getProducer()).toBe(replacement);
			expect(replacement?.closed).toBe(false);
			expect(f.c.isLive()).toBe(true);
			expect(f.audio.stop).not.toHaveBeenCalled();
		});

		it('ignores old track-ended callbacks after replacement, including their state notification', async () => {
			const f = fixture(kind);
			await f.c.start();
			const old = f.captures[0];
			const handler = old?.videoTrack.onended;
			expect(handler).toBeDefined();
			await f.c.start();
			const replacement = f.c.getStream();
			f.audio.stop.mockClear();
			if (old && handler) handler.call(old.videoTrack, new Event('ended'));
			expect(f.c.getStream()).toBe(replacement);
			expect(f.c.isLive()).toBe(true);
			expect(f.onTrackEnded).not.toHaveBeenCalled();
			expect(f.audio.stop).not.toHaveBeenCalled();
		});
		it('keeps capture loss effective after detach and failed republish', async () => {
			const f = fixture(kind);
			await f.c.start();
			const capture = f.captures[0];
			const handler = capture?.videoTrack.onended;
			f.c.detachProducer();
			f.publications.push(Promise.reject(new Error('republish failed')));
			await expect(f.c.republish()).rejects.toThrow('republish failed');
			expect(capture?.videoTrack.readyState).toBe('live');
			if (capture && handler) handler.call(capture.videoTrack, new Event('ended'));
			expect(f.c.getStream()).toBeUndefined();
			expect(f.c.getProducer()).toBeUndefined();
			expect(capture?.videoTrack.readyState).toBe('ended');
		});
		it('keeps the original capture-ended callback effective after producer replacement', async () => {
			const f = fixture(kind);
			await f.c.start();
			const capture = f.captures[0];
			const handler = capture?.videoTrack.onended;
			f.c.detachProducer();
			await f.c.republish();
			const replacement = f.c.getProducer();
			if (capture && handler) handler.call(capture.videoTrack, new Event('ended'));
			expect(replacement?.closed).toBe(true);
			expect(f.c.getStream()).toBeUndefined();
		});
		it('preserves capture when detaching during publication and a late allocation completes', async () => {
			const f = fixture(kind);
			await f.c.start();
			const capture = f.c.getStream();
			f.c.detachProducer();
			const pending = deferred<Producer<AppData>>();
			f.publications.push(pending.promise);
			const republish = f.c.republish();
			const result = republish?.catch(() => {});
			await flush();
			f.c.detachProducer();
			const late = createProducer('obsolete');
			pending.resolve(late);
			await result;
			expect(late.closed).toBe(true);
			expect(f.c.getStream()).toBe(capture);
			expect(f.c.isLive()).toBe(true);
			expect(f.audio.stop).not.toHaveBeenCalled();
		});
		it('does not detach a current producer for an already expired recovery command', async () => {
			const f = fixture(kind);
			await f.c.start();
			const current = f.c.getProducer();
			await expect(f.c.republish(() => false)).rejects.toThrow();
			expect(f.c.getProducer()).toBe(current);
			expect(current?.closed).toBe(false);
			expect(f.c.isLive()).toBe(true);
		});

		it('rejects an expired recovery lease without stopping preserved capture', async () => {
			const f = fixture(kind);
			await f.c.start();
			f.c.detachProducer();
			await expect(f.c.republish(() => false)).rejects.toThrow();
			expect(f.c.isLive()).toBe(true);
			expect(f.c.getProducer()).toBeUndefined();
		});
		it('rejects deferred acquisition across cleanup and lifecycle replay without disturbing the successor', async () => {
			const f = fixture(kind);
			const pending = deferred<MediaStream>();
			const old = createCapture();
			f.acquisitions.push(pending.promise);
			const start = f.c.start().catch(() => {});
			await flush();
			f.dispose();
			f.c.activate();
			await f.c.start();
			const replacement = f.c.getStream();
			pending.resolve(old.stream);
			await start;
			expect(old.videoTrack.readyState).toBe('ended');
			expect(f.c.getStream()).toBe(replacement);
			expect(f.c.isLive()).toBe(true);
		});
	});
}
it('mount cleanup is idempotent across lifecycle replay', async () => {
	const f = createVideoFixture();
	const webcam = createWebcamController(f.deps);
	const cleanup = mountWebcamController(webcam);
	await webcam.start();
	cleanup();
	const next = mountWebcamController(webcam);
	await webcam.start();
	cleanup();
	expect(webcam.isLive()).toBe(true);
	next();
	const screen = createScreenShareController({
		...f.deps,
		shareAudio: {
			stop: async () => {},
			awaitTeardown: async () => {},
			adoptDisplayAudio: () => {},
			discardDisplayAudio: () => {},
			start: async () => 'none',
		},
		getDesktopBridge: () => undefined,
		requestSelection: async () => null,
		warning: () => {},
		now: () => 0,
		setInterval: (handler, ms) => {
			const timer = setInterval(handler, ms);
			timer.unref();
			return timer;
		},
		clearInterval,
	});
	const stop = mountScreenShareController(screen);
	await screen.start();
	stop();
	const resumed = mountScreenShareController(screen);
	await screen.start();
	stop();
	expect(screen.isLive()).toBe(true);
	resumed();
});
