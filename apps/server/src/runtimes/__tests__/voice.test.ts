import { afterEach, describe, expect, test } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import type { AppData, Consumer } from 'mediasoup/types';
import { VoiceRuntime } from '../voice';

/**
 * Regression tests for the in-session transport rebuild path.
 *
 * When a WebRTC transport's DTLS state transitions to "failed" or "closed",
 * the client calls recoverTransportSession(), which:
 *   1. Closes the existing producer + consumer transports locally
 *   2. Calls voice.createProducerTransport + voice.createConsumerTransport
 *      over TRPC to get fresh server-side transports
 *   3. Republishes any live local tracks
 *   4. Re-consumes remote producers
 *
 * The server-side contract that makes this safe is that
 * VoiceRuntime.createProducerTransport / createConsumerTransport close the
 * previous transport for the same user before storing the new one. These
 * tests lock that down so a regression surfaces immediately.
 */

// Use large channel IDs that won't collide with test-seeded data.
const CHANNEL_BASE = 90_000;
let channelCounter = 0;

const nextChannelId = () => CHANNEL_BASE + ++channelCounter;

const makeCloseConsumer = (id: string, fireObserverOnClose = true) => {
	let closeHandler: (() => void) | undefined;
	let closed = false;

	const consumer = {
		id,
		get closed() {
			return closed;
		},
		observer: {
			on: (_event: string, handler: () => void) => {
				closeHandler = handler;
			},
		},
		close: () => {
			if (closed) {
				return;
			}

			closed = true;
			if (fireObserverOnClose) {
				closeHandler?.();
			}
		},
	} as unknown as Consumer<AppData>;

	return { consumer };
};

describe('VoiceRuntime in-session transport rebuild', () => {
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

	test('rebuilding the producer transport closes the old one and replaces it', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		await runtime.createProducerTransport(1);
		const first = runtime.getProducerTransport(1);

		await runtime.createProducerTransport(1);
		const second = runtime.getProducerTransport(1);

		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first!.id).not.toBe(second!.id);
		expect(first!.closed).toBe(true);
		expect(second!.closed).toBe(false);
	});

	test('rebuilding the consumer transport closes the old one and replaces it', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		await runtime.createConsumerTransport(1);
		const first = runtime.getConsumerTransport(1);

		await runtime.createConsumerTransport(1);
		const second = runtime.getConsumerTransport(1);

		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first!.id).not.toBe(second!.id);
		expect(first!.closed).toBe(true);
		expect(second!.closed).toBe(false);
	});

	test('full transport rebuild leaves the user in the voice channel with open transports', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		// Initial session
		await runtime.createProducerTransport(1);
		await runtime.createConsumerTransport(1);

		// Rebuild — mirrors what recoverTransportSession drives over TRPC
		const newProducerParams = await runtime.createProducerTransport(1);
		const newConsumerParams = await runtime.createConsumerTransport(1);

		expect(runtime.getUser(1)).toBeDefined();
		expect(newProducerParams.id).toBeTruthy();
		expect(newConsumerParams.id).toBeTruthy();
		expect(runtime.getProducerTransport(1)?.closed).toBe(false);
		expect(runtime.getConsumerTransport(1)?.closed).toBe(false);
	});

	test('removeUser after a rebuild closes the rebuilt transports', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		await runtime.createProducerTransport(1);
		await runtime.createConsumerTransport(1);

		// Rebuild
		await runtime.createProducerTransport(1);
		await runtime.createConsumerTransport(1);

		const rebuiltProducer = runtime.getProducerTransport(1);
		const rebuiltConsumer = runtime.getConsumerTransport(1);

		runtime.removeUser(1);

		expect(runtime.getUser(1)).toBeUndefined();
		expect(rebuiltProducer?.closed).toBe(true);
		expect(rebuiltConsumer?.closed).toBe(true);
	});

	test('concurrent rebuild calls for the same user are handled without leaving an open orphan', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		// Fire two producer-transport creations without awaiting the first.
		// The second must close whatever the first created.
		const [_params1, _params2] = await Promise.all([
			runtime.createProducerTransport(1),
			runtime.createProducerTransport(1),
		]);

		const surviving = runtime.getProducerTransport(1);

		expect(surviving).toBeDefined();
		expect(surviving!.closed).toBe(false);
	});

	test('late DTLS failures from replaced transports cannot close their successors', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		await runtime.createProducerTransport(1);
		const oldProducerTransport = runtime.getProducerTransport(1);
		await runtime.createProducerTransport(1);
		const newProducerTransport = runtime.getProducerTransport(1);
		await runtime.createConsumerTransport(1);
		const oldConsumerTransport = runtime.getConsumerTransport(1);
		await runtime.createConsumerTransport(1);
		const newConsumerTransport = runtime.getConsumerTransport(1);

		if (!oldProducerTransport || !newProducerTransport || !oldConsumerTransport || !newConsumerTransport) {
			throw new Error('Expected both transport generations to be available');
		}

		oldProducerTransport.emit('dtlsstatechange', 'failed');
		oldConsumerTransport.emit('dtlsstatechange', 'failed');

		expect(runtime.getProducerTransport(1)).toBe(newProducerTransport);
		expect(runtime.getConsumerTransport(1)).toBe(newConsumerTransport);
		expect(newProducerTransport.closed).toBe(false);
		expect(newConsumerTransport.closed).toBe(false);
	});

	test('targeted consumer cleanup skips a newer replacement consumer', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const first = makeCloseConsumer('first-consumer');
		runtime.addConsumer(1, 2, StreamKind.AUDIO, first.consumer);

		const second = makeCloseConsumer('second-consumer');
		runtime.addConsumer(1, 2, StreamKind.AUDIO, second.consumer);

		runtime.removeConsumer(1, 2, StreamKind.AUDIO, 'first-consumer');

		expect(first.consumer.closed).toBe(true);
		expect(second.consumer.closed).toBe(false);

		runtime.removeConsumer(1, 2, StreamKind.AUDIO, 'second-consumer');

		expect(second.consumer.closed).toBe(true);
	});

	test('drops a client voice-state update whose seq is older than the last applied one', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		expect(runtime.applyClientVoiceStateUpdate(1, { micMuted: true }, 2)).toBe(true);
		expect(runtime.applyClientVoiceStateUpdate(1, { micMuted: false }, 1)).toBe(false);

		expect(runtime.getUserState(1)?.micMuted).toBe(true);
	});

	test('applies un-sequenced client voice-state updates unconditionally', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		expect(runtime.applyClientVoiceStateUpdate(1, { micMuted: true }, 3)).toBe(true);
		expect(runtime.applyClientVoiceStateUpdate(1, { micMuted: false })).toBe(true);

		expect(runtime.getUserState(1)?.micMuted).toBe(false);
	});

	test('resets client voice-state seq tracking when the user leaves the channel', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		expect(runtime.applyClientVoiceStateUpdate(1, { micMuted: true }, 5)).toBe(true);

		runtime.removeUser(1);
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		expect(runtime.applyClientVoiceStateUpdate(1, { micMuted: true }, 1)).toBe(true);
		expect(runtime.getUserState(1)?.micMuted).toBe(true);
	});

	test('rejects client voice-state updates for users not in the channel', async () => {
		const runtime = await makeRuntime();

		expect(runtime.applyClientVoiceStateUpdate(1, { micMuted: true }, 1)).toBe(false);
	});

	test('assigns a fresh session incarnation per seat and clears it on removal', async () => {
		const runtime = await makeRuntime();

		expect(runtime.getVoiceSessionIncarnation(1)).toBeUndefined();

		runtime.addUser(1, { micMuted: false, soundMuted: false });
		const firstIncarnation = runtime.getVoiceSessionIncarnation(1);
		expect(firstIncarnation).toBeDefined();

		// addUser on an existing seat is a no-op and must not rotate the token.
		runtime.addUser(1, { micMuted: true, soundMuted: true });
		expect(runtime.getVoiceSessionIncarnation(1)).toBe(firstIncarnation!);

		runtime.removeUser(1);
		expect(runtime.getVoiceSessionIncarnation(1)).toBeUndefined();

		runtime.addUser(1, { micMuted: false, soundMuted: false });
		expect(runtime.getVoiceSessionIncarnation(1)).toBeDefined();
		expect(runtime.getVoiceSessionIncarnation(1)).not.toBe(firstIncarnation!);
	});

	test('does not remove a successor seat for a stale session incarnation', async () => {
		const runtime = await makeRuntime();

		runtime.addUser(1, { micMuted: false, soundMuted: false });
		const disconnectedIncarnation = runtime.getVoiceSessionIncarnation(1);

		runtime.removeUser(1);
		runtime.addUser(1, { micMuted: true, soundMuted: false });
		const successorIncarnation = runtime.getVoiceSessionIncarnation(1);

		expect(runtime.removeUserIfSessionMatches(1, disconnectedIncarnation)).toBe(false);
		expect(runtime.getVoiceSessionIncarnation(1)).toBe(successorIncarnation);
		expect(runtime.getUser(1)).toBeDefined();

		expect(runtime.removeUserIfSessionMatches(1, successorIncarnation)).toBe(true);
		expect(runtime.getUser(1)).toBeUndefined();
	});
});
