import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ServerEvents, StreamKind } from '@sharkord/shared';
import type { AppData, Producer } from 'mediasoup/types';
import { pubsub } from '../../utils/pubsub';
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

describe('VoiceRuntime stream state reset on producer close', () => {
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

	test('an unexpected screen producer close resets sharingScreen and broadcasts', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		runtime.updateUserState(1, { sharingScreen: true });

		const screen = makeManualCloseProducer('screen');
		runtime.addProducer(1, StreamKind.SCREEN, screen.producer);

		const publishSpy = spyOn(pubsub, 'publish');

		screen.producer.close();
		screen.fireCloseEvent();

		expect(runtime.getUserState(1).sharingScreen).toBe(false);
		expect(publishSpy).toHaveBeenCalledWith(ServerEvents.USER_VOICE_STATE_UPDATE, {
			channelId: runtime.id,
			userId: 1,
			state: expect.objectContaining({ sharingScreen: false }),
		});

		publishSpy.mockRestore();
	});

	test('an unexpected webcam producer close resets webcamEnabled and broadcasts', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		runtime.updateUserState(1, { webcamEnabled: true });

		const video = makeManualCloseProducer('video');
		runtime.addProducer(1, StreamKind.VIDEO, video.producer);

		const publishSpy = spyOn(pubsub, 'publish');

		video.producer.close();
		video.fireCloseEvent();

		expect(runtime.getUserState(1).webcamEnabled).toBe(false);
		expect(publishSpy).toHaveBeenCalledWith(ServerEvents.USER_VOICE_STATE_UPDATE, {
			channelId: runtime.id,
			userId: 1,
			state: expect.objectContaining({ webcamEnabled: false }),
		});

		publishSpy.mockRestore();
	});

	test('a stale replaced-producer close does not reset the still-live share', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		runtime.updateUserState(1, { sharingScreen: true });

		const first = makeManualCloseProducer('first');
		runtime.addProducer(1, StreamKind.SCREEN, first.producer);

		const second = makeManualCloseProducer('second');
		runtime.addProducer(1, StreamKind.SCREEN, second.producer);

		const publishSpy = spyOn(pubsub, 'publish');

		// The replaced producer's close lands after the replacement registered —
		// it is stale and must not clear sharingScreen for the live producer.
		first.fireCloseEvent();

		expect(runtime.getUserState(1).sharingScreen).toBe(true);
		expect(publishSpy).not.toHaveBeenCalled();

		publishSpy.mockRestore();
	});

	test('a producer close during teardown does not broadcast a stale state update', async () => {
		const runtime = await makeRuntime();
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		runtime.updateUserState(1, { sharingScreen: true });

		const screen = makeManualCloseProducer('screen');
		runtime.addProducer(1, StreamKind.SCREEN, screen.producer);

		const publishSpy = spyOn(pubsub, 'publish');

		// removeUser drops the user from state before closing producers; a late
		// observer close must find no user and skip the broadcast (the leave
		// event already covers teardown).
		runtime.removeUser(1);
		screen.fireCloseEvent();

		expect(runtime.getUser(1)).toBeUndefined();
		expect(publishSpy).not.toHaveBeenCalledWith(ServerEvents.USER_VOICE_STATE_UPDATE, expect.anything());

		publishSpy.mockRestore();
	});
});
