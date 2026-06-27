/**
 * Tests for VoiceRuntime native app-audio PlainTransport ingest.
 *
 * The real mediasoup Router created by runtime.init() is reused, but
 * router.createPlainTransport is stubbed with a controllable mock transport so
 * the SRTP connect()/produce() ordering and the first-media ('tuple') gate can
 * be driven deterministically without sending real RTP.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ServerEvents, StreamKind } from '@sharkord/shared';
import type { AppData, PlainTransport, Producer } from 'mediasoup/types';
import { pubsub } from '../../utils/pubsub';
import { VoiceRuntime } from '../voice';

const CHANNEL_BASE = 95_000;
let channelCounter = 0;
const nextChannelId = () => CHANNEL_BASE + ++channelCounter;

const SERVER_SRTP = { cryptoSuite: 'AES_CM_128_HMAC_SHA1_80', keyBase64: 'server-key' } as const;
const CLIENT_SRTP = { cryptoSuite: 'AES_CM_128_HMAC_SHA1_80', keyBase64: 'client-key' } as const;

type TMockProducer = Producer<AppData> & { fireClose: () => void };

const makeMockProducer = (id: string): TMockProducer => {
	let closed = false;
	// mediasoup observers are EventEmitters — multiple 'close' listeners can be
	// registered (addProducer registers one; produceAppAudio registers another).
	const closeHandlers: Array<() => void> = [];

	return {
		id,
		get closed() {
			return closed;
		},
		observer: {
			on: (event: string, handler: () => void) => {
				if (event === 'close') {
					closeHandlers.push(handler);
				}
			},
		},
		close: () => {
			if (closed) return;
			closed = true;
			for (const handler of [...closeHandlers]) {
				handler();
			}
		},
		fireClose: () => {
			for (const handler of [...closeHandlers]) {
				handler();
			}
		},
	} as unknown as TMockProducer;
};

type TMockPlainTransport = {
	transport: PlainTransport<AppData>;
	fireTuple: () => void;
	producers: TMockProducer[];
};

const makeMockPlainTransport = (id: string, callLog: string[], localPort: number): TMockPlainTransport => {
	let closed = false;
	let tupleHandler: (() => void) | undefined;
	let closeHandler: (() => void) | undefined;
	const producers: TMockProducer[] = [];

	const transport = {
		id,
		get closed() {
			return closed;
		},
		tuple: { localIp: '127.0.0.1', localPort, protocol: 'udp' },
		srtpParameters: SERVER_SRTP,
		on: (event: string, handler: () => void) => {
			if (event === 'tuple') {
				tupleHandler = handler;
			}
		},
		observer: {
			on: (event: string, handler: () => void) => {
				if (event === 'close') {
					closeHandler = handler;
				}
			},
		},
		connect: async () => {
			callLog.push(`connect:${id}`);
		},
		produce: async () => {
			callLog.push(`produce:${id}`);
			const producer = makeMockProducer(`${id}-producer`);
			producers.push(producer);
			return producer;
		},
		close: () => {
			if (closed) return;
			closed = true;
			for (const producer of producers) {
				producer.close();
			}
			closeHandler?.();
		},
	} as unknown as PlainTransport<AppData>;

	return {
		transport,
		fireTuple: () => tupleHandler?.(),
		producers,
	};
};

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('VoiceRuntime app-audio ingest', () => {
	const runtimes: VoiceRuntime[] = [];

	afterEach(async () => {
		for (const runtime of runtimes) {
			try {
				await runtime.destroy();
			} catch {
				// ignore — runtime may already be torn down
			}
		}
		runtimes.length = 0;
	});

	const makeRuntime = async (): Promise<VoiceRuntime> => {
		const runtime = new VoiceRuntime(nextChannelId());
		runtimes.push(runtime);
		await runtime.init();
		return runtime;
	};

	test('allocates a unique SSRC per ingest matching the returned rtpParameters', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		runtime.addUser(2, { micMuted: false, soundMuted: false });

		const callLog: string[] = [];
		let counter = 0;
		const createSpy = spyOn(runtime.getRouter(), 'createPlainTransport').mockImplementation(
			(async () => makeMockPlainTransport(`t-${++counter}`, callLog, 40_000 + counter).transport) as never,
		);

		const first = await runtime.createAppAudioIngest(1);
		const second = await runtime.createAppAudioIngest(2);

		expect(first.ssrc).not.toBe(second.ssrc);
		expect(first.rtpParameters.encodings?.[0]?.ssrc).toBe(first.ssrc);
		expect(second.rtpParameters.encodings?.[0]?.ssrc).toBe(second.ssrc);

		createSpy.mockRestore();
	});

	test('returns the announced address as the send target, never the raw bind ip', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const listenSpy = spyOn(VoiceRuntime, 'getListenInfo').mockReturnValue({
			ip: '0.0.0.0',
			announcedAddress: '203.0.113.5',
			listenInfos: [],
		});
		const callLog: string[] = [];
		const createSpy = spyOn(runtime.getRouter(), 'createPlainTransport').mockResolvedValue(
			makeMockPlainTransport('t-1', callLog, 41_000).transport,
		);

		const result = await runtime.createAppAudioIngest(1);

		expect(result.ip).toBe('203.0.113.5');
		expect(result.ip).not.toBe('0.0.0.0');
		expect(result.srtpParameters).toEqual(SERVER_SRTP);

		createSpy.mockRestore();
		listenSpy.mockRestore();
	});

	test('connects SRTP before producing', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const callLog: string[] = [];
		const mock = makeMockPlainTransport('t-1', callLog, 42_000);
		const createSpy = spyOn(runtime.getRouter(), 'createPlainTransport').mockResolvedValue(mock.transport);

		await runtime.createAppAudioIngest(1);

		const producePromise = runtime.produceAppAudio(1, { srtpParameters: CLIENT_SRTP, firstMediaTimeoutMs: 1_000 });
		await flushMicrotasks();
		mock.fireTuple();
		await producePromise;

		expect(callLog).toEqual(['connect:t-1', 'produce:t-1']);

		createSpy.mockRestore();
	});

	test('publishes VOICE_NEW_PRODUCER on first media and returns the producer id', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const callLog: string[] = [];
		const mock = makeMockPlainTransport('t-1', callLog, 43_000);
		const createSpy = spyOn(runtime.getRouter(), 'createPlainTransport').mockResolvedValue(mock.transport);
		const publishSpy = spyOn(pubsub, 'publishForChannel');

		await runtime.createAppAudioIngest(1);

		const producePromise = runtime.produceAppAudio(1, { srtpParameters: CLIENT_SRTP, firstMediaTimeoutMs: 1_000 });
		await flushMicrotasks();
		mock.fireTuple();
		const result = await producePromise;

		expect(result).toEqual({ producerId: 't-1-producer' });
		expect(runtime.getProducer(StreamKind.SCREEN_AUDIO, 1)?.id).toBe('t-1-producer');
		expect(publishSpy).toHaveBeenCalledWith(
			runtime.id,
			ServerEvents.VOICE_NEW_PRODUCER,
			expect.objectContaining({ kind: StreamKind.SCREEN_AUDIO, remoteId: 1, producerId: 't-1-producer' }),
		);

		publishSpy.mockRestore();
		createSpy.mockRestore();
	});

	test('rejects a second produceAppAudio against the same ingest', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const callLog: string[] = [];
		const mock = makeMockPlainTransport('t-1', callLog, 43_500);
		const createSpy = spyOn(runtime.getRouter(), 'createPlainTransport').mockResolvedValue(mock.transport);

		await runtime.createAppAudioIngest(1);

		const producePromise = runtime.produceAppAudio(1, { srtpParameters: CLIENT_SRTP, firstMediaTimeoutMs: 1_000 });
		await flushMicrotasks();
		mock.fireTuple();
		await producePromise;

		await expect(
			runtime.produceAppAudio(1, { srtpParameters: CLIENT_SRTP, firstMediaTimeoutMs: 1_000 }),
		).rejects.toThrow('already producing');

		createSpy.mockRestore();
	});

	test('a tuple that fires before produceAppAudio still resolves to a producer (early-media race)', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const callLog: string[] = [];
		const mock = makeMockPlainTransport('t-1', callLog, 44_000);
		const createSpy = spyOn(runtime.getRouter(), 'createPlainTransport').mockResolvedValue(mock.transport);

		await runtime.createAppAudioIngest(1);

		// Media arrives before the client calls produceAppAudio — the listener was
		// attached at create time, so it must not be missed.
		mock.fireTuple();

		const result = await runtime.produceAppAudio(1, { srtpParameters: CLIENT_SRTP, firstMediaTimeoutMs: 50 });

		expect(result).toEqual({ producerId: 't-1-producer' });

		createSpy.mockRestore();
	});

	test('falls back and tears down when no media arrives within the timeout', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const callLog: string[] = [];
		const mock = makeMockPlainTransport('t-1', callLog, 45_000);
		const createSpy = spyOn(runtime.getRouter(), 'createPlainTransport').mockResolvedValue(mock.transport);
		const publishSpy = spyOn(pubsub, 'publishForChannel');

		await runtime.createAppAudioIngest(1);

		const result = await runtime.produceAppAudio(1, { srtpParameters: CLIENT_SRTP, firstMediaTimeoutMs: 30 });

		expect(result).toEqual({ fallback: true });
		expect(mock.transport.closed).toBe(true);
		expect(mock.producers[0]?.closed).toBe(true);
		expect(runtime.getAppAudioIngest(1)).toBeUndefined();
		expect(publishSpy).not.toHaveBeenCalledWith(runtime.id, ServerEvents.VOICE_NEW_PRODUCER, expect.anything());

		publishSpy.mockRestore();
		createSpy.mockRestore();
	});

	test('removeUser closes the ingest transport and producer and publishes VOICE_PRODUCER_CLOSED once', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const callLog: string[] = [];
		const mock = makeMockPlainTransport('t-1', callLog, 46_000);
		const createSpy = spyOn(runtime.getRouter(), 'createPlainTransport').mockResolvedValue(mock.transport);

		await runtime.createAppAudioIngest(1);
		const producePromise = runtime.produceAppAudio(1, { srtpParameters: CLIENT_SRTP, firstMediaTimeoutMs: 1_000 });
		await flushMicrotasks();
		mock.fireTuple();
		await producePromise;

		const publishSpy = spyOn(pubsub, 'publishForChannel');

		runtime.removeUser(1);

		expect(mock.transport.closed).toBe(true);
		expect(mock.producers[0]?.closed).toBe(true);
		expect(runtime.getAppAudioIngest(1)).toBeUndefined();

		const closedPublishes = publishSpy.mock.calls.filter((call) => call[1] === ServerEvents.VOICE_PRODUCER_CLOSED);
		expect(closedPublishes).toHaveLength(1);
		expect(closedPublishes[0]?.[2]).toMatchObject({
			kind: StreamKind.SCREEN_AUDIO,
			remoteId: 1,
			producerId: 't-1-producer',
		});

		publishSpy.mockRestore();
		createSpy.mockRestore();
	});

	test('creating a second ingest for a user closes the prior transport', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const callLog: string[] = [];
		const first = makeMockPlainTransport('t-1', callLog, 47_000);
		const second = makeMockPlainTransport('t-2', callLog, 47_001);
		const createSpy = spyOn(runtime.getRouter(), 'createPlainTransport')
			.mockResolvedValueOnce(first.transport)
			.mockResolvedValueOnce(second.transport);

		await runtime.createAppAudioIngest(1);
		await runtime.createAppAudioIngest(1);

		expect(first.transport.closed).toBe(true);
		expect(second.transport.closed).toBe(false);
		expect(runtime.getAppAudioIngest(1)?.transport).toBe(second.transport);

		createSpy.mockRestore();
	});
});
