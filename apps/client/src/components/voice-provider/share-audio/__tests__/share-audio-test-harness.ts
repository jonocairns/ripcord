import { mock } from 'bun:test';
import type { AppData, Producer, Transport } from 'mediasoup-client/types';
import type {
	TAppAudioFrame,
	TAppAudioPcmFrame,
	TAppAudioSession,
	TAppAudioStatusEvent,
	TDesktopBridge,
} from '@/runtime/types';
import type { TDesktopAppAudioPipeline } from '../desktop-app-audio';
import {
	createShareAudioController,
	mountShareAudioController,
	type TShareAudioDependencies,
} from '../share-audio-controller';

const deferred = <T = void>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};
const flush = async () => {
	for (let i = 0; i < 30; i++) await Promise.resolve();
};
const makeTrack = (kind = 'audio') => {
	let readyState: MediaStreamTrackState = 'live';
	const stop = mock(() => {
		readyState = 'ended';
	});
	// Only the browser track surface used by this controller is needed.
	const track = {
		kind,
		get readyState() {
			return readyState;
		},
		stop,
		onended: null,
	} as unknown as MediaStreamTrack;
	return { track, stop };
};
const makeStream = (tracks: MediaStreamTrack[]) => {
	let current = [...tracks];
	return {
		getTracks: () => [...current],
		getAudioTracks: () => current.filter((track) => track.kind === 'audio'),
		getVideoTracks: () => current.filter((track) => track.kind === 'video'),
		removeTrack: (track: MediaStreamTrack) => {
			current = current.filter((value) => value !== track);
		},
	} as MediaStream;
};
const makeProducer = (id: string) => {
	const listeners: (() => void)[] = [];
	let closed = false;
	const close = mock(() => {
		if (closed) return;
		closed = true;
		listeners.forEach((listener) => listener());
	});
	const producer = {
		id,
		get closed() {
			return closed;
		},
		close,
		on: (_event: string, listener: () => void) => {
			listeners.push(listener);
		},
	} as unknown as Producer<AppData>;
	return { producer, close };
};
const makePipeline = (sessionId: string) => {
	const { track, stop } = makeTrack();
	const pipeline: TDesktopAppAudioPipeline = {
		sessionId,
		track,
		stream: makeStream([track]),
		pushFrame: mock(() => {}),
		destroy: mock(async () => {
			stop();
		}),
	};
	return pipeline;
};
const makeSession = (sessionId: string): TAppAudioSession => ({
	sessionId,
	targetId: 'target',
	sampleRate: 48000,
	channels: 2,
	framesPerBuffer: 480,
});
const makeFixture = () => {
	let sessionNumber = 0;
	let producerNumber = 0;
	let nativeEnabled = true;
	let videoLive = true;
	let stream: MediaStream | undefined;
	const producers: ReturnType<typeof makeProducer>[] = [];
	const pipelines: TDesktopAppAudioPipeline[] = [];
	const statuses: ((event: TAppAudioStatusEvent) => void)[] = [];
	const frames: ((event: TAppAudioFrame | TAppAudioPcmFrame) => void)[] = [];
	const unsubscribeStatus = mock(() => {});
	const unsubscribeFrames = mock(() => {});
	const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
	const stopRtp = mock(async () => {});
	const bridge = {
		startAppAudioCapture: mock(async () => makeSession(`session-${++sessionNumber}`)),
		stopAppAudioCapture: mock(async (_sessionId: string) => {}),
		startAppAudioRtp: mock(async () => ({ srtpKeyBase64: 'key' })),
		stopAppAudioRtp: stopRtp,
		getCapabilities: mock(async () => ({ platform: 'linux', issues: [], notes: [] })),
		subscribeAppAudioStatus: mock((handler: (event: TAppAudioStatusEvent) => void) => {
			statuses.push(handler);
			return () => unsubscribeStatus();
		}),
		subscribeAppAudioFrames: mock((handler: (event: TAppAudioFrame | TAppAudioPcmFrame) => void) => {
			frames.push(handler);
			return () => unsubscribeFrames();
		}),
	} as unknown as TDesktopBridge;
	const produce = mock(async () => {
		const producer = makeProducer(`producer-${++producerNumber}`);
		producers.push(producer);
		return producer.producer;
	});
	let transport = { closed: false, produce } as unknown as Transport<AppData>;
	const deps: TShareAudioDependencies = {
		getDesktopBridge: () => bridge,
		getProducerTransport: () => transport,
		isNativeIngestEnabled: () => nativeEnabled,
		createIngest: mock(async () => ({
			id: 'ingest-1',
			ip: '127.0.0.1',
			port: 10000,
			ssrc: 123,
			rtpParameters: { codecs: [{ mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2 }] },
			srtpParameters: { cryptoSuite: 'AES_CM_128_HMAC_SHA1_80' as const, keyBase64: 'server-key' },
		})),
		produceNative: mock(async () => ({ producerId: 'native-1' })),
		abortIngest: mock(async (_transportId: string) => {}),
		closeProducer: mock(async (_producerId?: string) => {}),
		createPipeline: mock(async (session) => {
			const pipeline = makePipeline(session.sessionId);
			pipelines.push(pipeline);
			return pipeline;
		}),
		createStream: makeStream,
		publishStream: mock((value) => {
			stream = value;
		}),
		warning: mock(() => {}),
		log: mock(() => {}),
		setTimeout: (handler) => {
			const handle = setTimeout(() => {}, 3600000);
			clearTimeout(handle);
			timers.set(handle, handler);
			return handle;
		},
		clearTimeout: (handle) => {
			timers.delete(handle);
		},
	};
	const controller = createShareAudioController(deps);
	const cleanup = mountShareAudioController(controller);
	return {
		stopRtp,
		controller,
		cleanup,
		deps,
		bridge,
		produce,
		producers,
		pipelines,
		statuses,
		frames,
		unsubscribeStatus,
		unsubscribeFrames,
		timers,
		getStream: () => stream,
		setNativeEnabled: (value: boolean) => {
			nativeEnabled = value;
		},
		// Production callers pass the screen owner's getter per start/recovery call.
		isVideoLive: () => videoLive,
		setVideoLive: (value: boolean) => {
			videoLive = value;
		},
		replaceTransport: () => {
			transport = { closed: false, produce } as unknown as Transport<AppData>;
		},
	};
};
const status = (sessionId: string): TAppAudioStatusEvent => ({
	sessionId,
	targetId: 'target',
	reason: 'capture_stopped',
});
const frame = (sessionId: string): TAppAudioPcmFrame => ({
	sessionId,
	targetId: 'target',
	sequence: 1,
	sampleRate: 48000,
	channels: 2,
	frameCount: 480,
	protocolVersion: 1,
	pcm: new Float32Array(960),
});

export { deferred, flush, frame, makeFixture, makePipeline, makeProducer, makeSession, makeStream, makeTrack, status };
