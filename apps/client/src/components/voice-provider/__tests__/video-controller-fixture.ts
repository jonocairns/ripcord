import { mock } from 'bun:test';
import type { AppData, Producer, ProducerOptions, Transport } from 'mediasoup-client/types';
import { DEFAULT_DEVICE_SETTINGS } from '../../devices-provider/migrate-device-settings';

const deferred = <T>() => {
	let resolve: (value: T) => void = () => {
		throw new Error('Not initialized');
	};
	let reject: (error: unknown) => void = () => {
		throw new Error('Not initialized');
	};
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
const flush = async () => {
	for (let i = 0; i < 40; i += 1) await Promise.resolve();
};
const createCapture = (audio = false) => {
	const makeTrack = (kind: string) => {
		let readyState: MediaStreamTrackState = 'live';
		const track = {
			kind,
			onended: null,
			contentHint: '',
			get readyState() {
				return readyState;
			},
			getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }),
			stop: mock(() => {
				readyState = 'ended';
			}),
		} as unknown as MediaStreamTrack;
		return track;
	};
	const videoTrack = makeTrack('video');
	const audioTrack = audio ? makeTrack('audio') : undefined;
	let tracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
	const stream = {
		getTracks: () => tracks,
		getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
		getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
		removeTrack: (track: MediaStreamTrack) => {
			tracks = tracks.filter((current) => current !== track);
		},
	} as unknown as MediaStream;
	return { stream, videoTrack, audioTrack, end: () => videoTrack.onended?.call(videoTrack, new Event('ended')) };
};
const createProducer = (id: string, track?: MediaStreamTrack, sender?: RTCRtpSender) => {
	let closed = false;
	const listeners: Array<() => void> = [];
	return {
		id,
		track,
		rtpSender: sender,
		get closed() {
			return closed;
		},
		on: (_event: string, listener: () => void) => {
			listeners.push(listener);
		},
		close: mock(() => {
			if (closed) return;
			closed = true;
			listeners.forEach((listener) => listener());
		}),
	} as unknown as Producer<AppData>;
};
const createVideoFixture = () => {
	let devices = { ...DEFAULT_DEVICE_SETTINGS };
	const acquisitions: Array<Promise<MediaStream>> = [];
	const publications: Array<Promise<Producer<AppData>>> = [];
	const captures: ReturnType<typeof createCapture>[] = [];
	const producers: Producer<AppData>[] = [];
	const produce = mock(async (options: ProducerOptions<AppData>) => {
		const result = publications.shift();
		if (result) return result;
		const producer = createProducer(`producer-${producers.length}`, options.track);
		producers.push(producer);
		return producer;
	});
	let transport = { closed: false, produce } as unknown as Transport<AppData>;
	const acquire = mock(async (_constraints: MediaStreamConstraints | DisplayMediaStreamOptions) => {
		const result = acquisitions.shift();
		if (result) return result;
		const capture = createCapture();
		captures.push(capture);
		return capture.stream;
	});
	const publishStream = mock((_stream: MediaStream | undefined) => {});
	const closeProducer = mock((_id: string) => {});
	const onTrackEnded = mock(() => {});
	const deps = {
		getDevices: () => devices,
		getProducerTransport: () => transport,
		getRtpCapabilities: () => null,
		acquire,
		publishStream,
		closeProducer,
		onTrackEnded,
		log: mock((_message: string, _data?: Record<string, unknown>) => {}),
	};
	return {
		deps,
		captures,
		producers,
		acquisitions,
		publications,
		produce,
		acquire,
		publishStream,
		closeProducer,
		onTrackEnded,
		setDevices: (next: typeof devices) => {
			devices = next;
		},
		getDevices: () => devices,
		replaceTransport: () => {
			transport = { closed: false, produce } as unknown as Transport<AppData>;
		},
	};
};

export { createCapture, createProducer, createVideoFixture, deferred, flush };
