import { afterEach, describe, expect, test } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import type { AppData, Producer } from 'mediasoup/types';
import { VoiceRuntime } from '../voice';

/**
 * Regression tests for VoiceRuntime.addProducer replacement semantics.
 *
 * Registering a new producer for a user+kind that already has one must close
 * the old producer (otherwise it stays attached to the transport), and a
 * *late* close event from the replaced producer must not evict the
 * replacement from the map or broadcast VOICE_PRODUCER_CLOSED for a stream
 * that is still live.
 */

// Use large channel IDs that won't collide with test-seeded data.
const CHANNEL_BASE = 94_000;
let channelCounter = 0;

const nextChannelId = () => CHANNEL_BASE + ++channelCounter;

/**
 * Producer stub whose observer 'close' event can be fired independently of
 * close() — mediasoup delivers observer events asynchronously, so a replaced
 * producer's close can land after its successor was registered.
 */
const makeManualCloseProducer = (id: string) => {
	let closeHandler: (() => void) | undefined;
	let closed = false;

	const producer = {
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
			closed = true;
		},
	} as unknown as Producer<AppData>;

	return {
		producer,
		fireCloseEvent: () => {
			closeHandler?.();
		},
	};
};

describe('VoiceRuntime producer replacement', () => {
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

	test('registering a same-kind producer closes the replaced one', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const first = makeManualCloseProducer('first');
		runtime.addProducer(1, StreamKind.SCREEN, first.producer);

		const second = makeManualCloseProducer('second');
		runtime.addProducer(1, StreamKind.SCREEN, second.producer);

		expect(first.producer.closed).toBe(true);
		expect(second.producer.closed).toBe(false);
		expect(runtime.getProducer(StreamKind.SCREEN, 1)).toBe(second.producer);
	});

	test('a late close event from a replaced producer does not evict the replacement', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const first = makeManualCloseProducer('first');
		runtime.addProducer(1, StreamKind.SCREEN, first.producer);

		const second = makeManualCloseProducer('second');
		runtime.addProducer(1, StreamKind.SCREEN, second.producer);

		// The replaced producer's observer close arrives after the replacement
		// was registered — it must be treated as stale.
		first.fireCloseEvent();

		expect(runtime.getProducer(StreamKind.SCREEN, 1)).toBe(second.producer);
		expect(second.producer.closed).toBe(false);
	});

	test('the active producer close still clears the map entry', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });

		const only = makeManualCloseProducer('only');
		runtime.addProducer(1, StreamKind.SCREEN, only.producer);

		only.producer.close();
		only.fireCloseEvent();

		expect(runtime.getProducer(StreamKind.SCREEN, 1)).toBeUndefined();
	});
});
