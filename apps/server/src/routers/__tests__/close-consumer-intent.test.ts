/**
 * The close-consumer intent is the compatibility contract for watcher cues:
 * only a viewer's own stop tells the streamer they left. Shipped clients send
 * no intent and keep counting every close as a stop.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ServerEvents, StreamKind, type TCloseConsumerIntent } from '@sharkord/shared';
import type { AppData, Consumer } from 'mediasoup/types';
import { createMockContext } from '../../__tests__/context';
import { getMockedToken } from '../../__tests__/helpers';
import { appRouter } from '../../routers';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';

const CHANNEL_BASE = 98_000;
let channelCounter = 0;
const nextChannelId = () => CHANNEL_BASE + ++channelCounter;

const STREAMER = 2;

const makeConsumer = (id: string): Consumer<AppData> => {
	let closeHandler: (() => void) | undefined;
	let closed = false;

	return {
		id,
		paused: true,
		get closed() {
			return closed;
		},
		observer: {
			on: (_event: string, handler: () => void) => {
				closeHandler = handler;
			},
		},
		resume: async () => {},
		close: () => {
			if (closed) return;
			closed = true;
			closeHandler?.();
		},
	} as unknown as Consumer<AppData>;
};

describe('voice.closeConsumer intent', () => {
	const runtimes: VoiceRuntime[] = [];
	const restores: (() => void)[] = [];

	afterEach(async () => {
		for (const restore of restores) restore();
		restores.length = 0;

		for (const runtime of runtimes) {
			try {
				await runtime.destroy();
			} catch {
				// ignore — runtime may already be torn down
			}
		}
		runtimes.length = 0;
	});

	// The caller's user watches STREAMER's screen share.
	const setup = async () => {
		const mockedToken = await getMockedToken(1);
		const ctx = await createMockContext({ customToken: mockedToken });
		const caller = appRouter.createCaller(ctx);
		const { handshakeHash } = await caller.others.handshake();
		await caller.others.joinServer({ handshakeHash });

		const runtime = new VoiceRuntime(nextChannelId());
		runtimes.push(runtime);
		await runtime.init();
		runtime.addUser(ctx.user.id, { micMuted: false, soundMuted: false });
		runtime.addUser(STREAMER, { micMuted: false, soundMuted: false });
		ctx.currentVoiceChannelId = runtime.id;

		runtime.addConsumer(ctx.user.id, STREAMER, StreamKind.SCREEN, makeConsumer('screen-1'));
		await runtime.resumeConsumer(ctx.user.id, STREAMER, StreamKind.SCREEN, 'screen-1');

		const publishSpy = spyOn(pubsub, 'publishFor');
		restores.push(() => publishSpy.mockRestore());

		const leftCues = () =>
			publishSpy.mock.calls.filter(
				(call) =>
					call[1] === ServerEvents.VOICE_STREAM_WATCHER_ACTIVITY &&
					typeof call[2] === 'object' &&
					call[2] !== null &&
					'action' in call[2] &&
					call[2].action === 'left' &&
					!('sync' in call[2]),
			).length;

		const close = (intent?: TCloseConsumerIntent) =>
			caller.voice.closeConsumer({ remoteId: STREAMER, kind: StreamKind.SCREEN, consumerId: 'screen-1', intent });

		return { leftCues, close };
	};

	test('a maintenance close keeps the viewer watching', async () => {
		const { leftCues, close } = await setup();

		await close('maintenance');

		expect(leftCues()).toBe(0);
	});

	test('a stop-watching close cues the streamer', async () => {
		const { leftCues, close } = await setup();

		await close('stop-watching');

		expect(leftCues()).toBe(1);
	});

	test('a close with no intent from a shipped client counts as a stop', async () => {
		const { leftCues, close } = await setup();

		await close();

		expect(leftCues()).toBe(1);
	});
});
