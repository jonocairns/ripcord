import { afterEach, describe, expect, it } from 'bun:test';
import {
	createCapture,
	createProducer,
	createVideoFixture,
	deferred,
	flush,
} from '../../__tests__/video-controller-fixture';
import { createShareAudioController, mountShareAudioController } from '../../share-audio/share-audio-controller';
import { createScreenShareController, mountScreenShareController } from '../screen-share-controller';

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
});
const fixture = () => {
	const f = createVideoFixture();
	let audioStream: MediaStream | undefined;
	const audio = createShareAudioController({
		getDesktopBridge: () => undefined,
		getProducerTransport: f.deps.getProducerTransport,
		isNativeIngestEnabled: () => false,
		createIngest: async () => {
			throw new Error('Unexpected ingest');
		},
		produceNative: async () => {
			throw new Error('Unexpected native publication');
		},
		abortIngest: async () => {},
		closeProducer: async () => {},
		createPipeline: async () => {
			throw new Error('Unexpected desktop pipeline');
		},
		createStream: (tracks) =>
			({
				getTracks: () => tracks,
				getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
				removeTrack: (track: MediaStreamTrack) => {
					tracks = tracks.filter((current) => current !== track);
				},
			}) as unknown as MediaStream,
		publishStream: (stream) => {
			audioStream = stream;
		},
		warning: () => {},
		log: () => {},
		setTimeout,
		clearTimeout,
	});
	disposers.push(mountShareAudioController(audio));
	const c = createScreenShareController({
		...f.deps,
		shareAudio: audio,
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
	disposers.push(mountScreenShareController(c));
	const capture = createCapture(true);
	f.acquisitions.push(Promise.resolve(capture.stream));
	return { ...f, c, audio, capture, getAudioStream: () => audioStream };
};
describe('production screen-video and share-audio coordination', () => {
	it('stops both owners through screen stop without stopping audio from the video owner', async () => {
		const f = fixture();
		await f.c.start();
		expect(f.getAudioStream()?.getAudioTracks()[0]).toBe(f.capture.audioTrack);
		f.c.stop();
		await f.audio.awaitTeardown();
		expect(f.capture.videoTrack.readyState).toBe('ended');
		expect(f.capture.audioTrack?.readyState).toBe('ended');
		expect(f.getAudioStream()).toBeUndefined();
		expect(f.c.getStream()).toBeUndefined();
	});
	it('republishes both surviving tracks after detach without reacquisition', async () => {
		const f = fixture();
		await f.c.start();
		f.c.detachProducer();
		f.audio.detachProducer();
		expect(f.capture.videoTrack.readyState).toBe('live');
		expect(f.capture.audioTrack?.readyState).toBe('live');
		await Promise.all([f.c.republish(), f.audio.republish()]);
		expect(f.acquire).toHaveBeenCalledTimes(1);
		expect(f.getAudioStream()?.getAudioTracks()[0]).toBe(f.capture.audioTrack);
		expect(f.c.isLive()).toBe(true);
		f.c.stop();
		await f.audio.awaitTeardown();
	});
	it('keeps audio and capture live after failed screen republish, then handles native track loss', async () => {
		const f = fixture();
		await f.c.start();
		f.c.detachProducer();
		f.audio.detachProducer();
		f.publications.push(Promise.reject(new Error('video recovery failed')));
		await expect(f.c.republish()).rejects.toThrow('video recovery failed');
		await f.audio.republish();
		expect(f.capture.videoTrack.readyState).toBe('live');
		expect(f.capture.audioTrack?.readyState).toBe('live');
		f.capture.end();
		await f.audio.awaitTeardown();
		expect(f.capture.audioTrack?.readyState).toBe('ended');
		expect(f.getAudioStream()).toBeUndefined();
	});
	it('disposes audio from a late mixed display acquisition through its scoped owner operation', async () => {
		const f = fixture();
		const late = createCapture(true);
		const pending = deferred<MediaStream>();
		f.acquisitions.splice(0, 1, pending.promise);
		const start = f.c.start().catch(() => {});
		await flush();
		f.c.stop();
		await f.c.start();
		const replacement = f.c.getStream();
		pending.resolve(late.stream);
		await start;
		expect(late.videoTrack.readyState).toBe('ended');
		expect(late.audioTrack?.readyState).toBe('ended');
		expect(f.c.getStream()).toBe(replacement);
		expect(f.c.isLive()).toBe(true);
		f.c.stop();
		await f.audio.awaitTeardown();
	});
	it('stops adopted display audio when video publication fails before audio startup', async () => {
		const f = fixture();
		f.publications.push(Promise.reject(new Error('video failed')));
		await expect(f.c.start()).rejects.toThrow('video failed');
		await f.audio.awaitTeardown();
		expect(f.capture.videoTrack.readyState).toBe('ended');
		expect(f.capture.audioTrack?.readyState).toBe('ended');
		expect(f.getAudioStream()).toBeUndefined();
	});
	it('rejects stop during deferred audio publication and closes late audio allocation without restoring video', async () => {
		const f = fixture();
		const lateAudio = createProducer('late-audio', f.capture.audioTrack);
		const pending = deferred<typeof lateAudio>();
		f.publications.push(Promise.resolve(createProducer('screen', f.capture.videoTrack)), pending.promise);
		const start = f.c.start().catch(() => {});
		await flush();
		f.c.stop();
		pending.resolve(lateAudio);
		await start;
		await f.audio.awaitTeardown();
		expect(lateAudio.closed).toBe(true);
		expect(f.capture.videoTrack.readyState).toBe('ended');
		expect(f.capture.audioTrack?.readyState).toBe('ended');
		expect(f.c.getStream()).toBeUndefined();
		expect(f.getAudioStream()).toBeUndefined();
	});
});
