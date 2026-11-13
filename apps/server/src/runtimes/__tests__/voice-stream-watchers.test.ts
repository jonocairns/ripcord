import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ServerEvents, StreamKind } from '@sharkord/shared';
import type { AppData, Consumer, Producer } from 'mediasoup/types';
import { pubsub } from '../../utils/pubsub';
import { VoiceRuntime } from '../voice';

/**
 * Watcher activity (the streamer's "joined/left your stream" cues) follows
 * viewer decisions, not consumer lifetime. Consumers close and reopen during
 * repairs, transport rebuilds and producer restores; none of that may reach the
 * streamer as a viewer leaving or joining.
 */

const CHANNEL_BASE = 97_000;
let channelCounter = 0;

const nextChannelId = () => CHANNEL_BASE + ++channelCounter;

const STREAMER = 2;
const VIEWER = 1;

const makeConsumer = (id: string, { paused = true } = {}) => {
	let closeHandler: (() => void) | undefined;
	let closed = false;
	let isPaused = paused;

	const consumer = {
		id,
		producerId: `producer-for-${id}`,
		get closed() {
			return closed;
		},
		get paused() {
			return isPaused;
		},
		observer: {
			on: (_event: string, handler: () => void) => {
				closeHandler = handler;
			},
		},
		resume: async () => {
			isPaused = false;
		},
		close: () => {
			if (closed) {
				return;
			}

			closed = true;
			closeHandler?.();
		},
	} as unknown as Consumer<AppData>;

	return consumer;
};

const makeProducer = (id: string) => {
	let closeHandler: (() => void) | undefined;
	let closed = false;

	return {
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
			closeHandler?.();
		},
	} as unknown as Producer<AppData>;
};

describe('VoiceRuntime stream watcher activity', () => {
	const runtimes: VoiceRuntime[] = [];
	const restores: (() => void)[] = [];

	afterEach(async () => {
		for (const restore of restores) {
			restore();
		}
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

	const setup = async () => {
		const runtime = new VoiceRuntime(nextChannelId());
		runtimes.push(runtime);
		await runtime.init();
		runtime.addUser(VIEWER, { micMuted: false, soundMuted: false });
		runtime.addUser(STREAMER, { micMuted: false, soundMuted: false });

		const publishSpy = spyOn(pubsub, 'publishFor');
		restores.push(() => publishSpy.mockRestore());

		const watcherActivity = () =>
			publishSpy.mock.calls
				.filter((call) => call[1] === ServerEvents.VOICE_STREAM_WATCHER_ACTIVITY)
				.map((call) => ({ to: call[0], payload: call[2] }));

		// Silent restatements show as 'sync' so tests can tell them from cues.
		const watcherActions = () =>
			watcherActivity().flatMap(({ payload }) => {
				if (typeof payload !== 'object' || payload === null || !('action' in payload)) {
					return [];
				}

				return ['sync' in payload && payload.sync ? 'sync' : payload.action];
			});

		const watch = async (consumerId: string, kind: StreamKind = StreamKind.SCREEN) => {
			runtime.addConsumer(VIEWER, STREAMER, kind, makeConsumer(consumerId));
			await runtime.resumeConsumer(VIEWER, STREAMER, kind, consumerId);
		};

		return { runtime, watcherActivity, watcherActions, watch };
	};

	test('a paused consume counts as watching only once resumed', async () => {
		const { runtime, watcherActivity } = await setup();

		runtime.addConsumer(VIEWER, STREAMER, StreamKind.SCREEN, makeConsumer('screen-1'));
		expect(watcherActivity()).toEqual([]);

		await runtime.resumeConsumer(VIEWER, STREAMER, StreamKind.SCREEN, 'screen-1');
		expect(watcherActivity()).toEqual([
			{ to: STREAMER, payload: { watcherId: VIEWER, kind: StreamKind.SCREEN, action: 'joined' } },
		]);
	});

	test('an unpaused consume counts as watching immediately', async () => {
		const { runtime, watcherActivity } = await setup();

		runtime.addConsumer(VIEWER, STREAMER, StreamKind.VIDEO, makeConsumer('video-1', { paused: false }));

		expect(watcherActivity()).toEqual([
			{ to: STREAMER, payload: { watcherId: VIEWER, kind: StreamKind.VIDEO, action: 'joined' } },
		]);
	});

	test('repairs and replacement consumers stay silent', async () => {
		const { runtime, watcherActions, watch } = await setup();

		await watch('screen-1');
		runtime.removeConsumer(VIEWER, STREAMER, StreamKind.SCREEN, 'screen-1');
		await watch('screen-2');
		await watch('screen-3');

		expect(watcherActions()).toEqual(['joined']);
	});

	test('a stop ends watching even after a repair dropped the consumer', async () => {
		const { runtime, watcherActivity, watcherActions, watch } = await setup();

		await watch('screen-1');
		runtime.removeConsumer(VIEWER, STREAMER, StreamKind.SCREEN, 'screen-1');
		runtime.removeConsumer(VIEWER, STREAMER, StreamKind.SCREEN, undefined, { stopWatching: true });

		expect(watcherActions()).toEqual(['joined', 'left']);

		runtime.removeConsumer(VIEWER, STREAMER, StreamKind.SCREEN, undefined, { stopWatching: true });
		expect(watcherActivity()).toHaveLength(2);
	});

	test('a stale stop leaves a newer consumer watching', async () => {
		const { runtime, watcherActions, watch } = await setup();

		await watch('screen-1');
		await watch('screen-2');
		runtime.removeConsumer(VIEWER, STREAMER, StreamKind.SCREEN, 'screen-1', { stopWatching: true });

		expect(watcherActions()).toEqual(['joined']);
	});

	test('a resume that loses a race with a stop does not count as watching', async () => {
		const { runtime, watcherActivity } = await setup();
		const consumer = makeConsumer('screen-1');

		runtime.addConsumer(VIEWER, STREAMER, StreamKind.SCREEN, consumer);
		const resume = runtime.resumeConsumer(VIEWER, STREAMER, StreamKind.SCREEN, 'screen-1');
		runtime.removeConsumer(VIEWER, STREAMER, StreamKind.SCREEN, 'screen-1', { stopWatching: true });
		await resume;

		expect(watcherActivity()).toEqual([]);
	});

	test('a departing viewer or streamer ends watching without watcher activity', async () => {
		const { runtime, watcherActions, watch } = await setup();

		await watch('screen-1');
		await watch('video-1', StreamKind.VIDEO);
		runtime.removeUser(VIEWER);

		expect(watcherActions()).toEqual(['joined', 'joined']);

		runtime.addUser(VIEWER, { micMuted: false, soundMuted: false });
		await watch('screen-2');
		runtime.removeUser(STREAMER);

		expect(watcherActions()).toEqual(['joined', 'joined', 'joined']);
	});

	test('an ended screen share forgets its viewers but a recoverable close keeps them', async () => {
		const { runtime, watcherActions, watch } = await setup();

		runtime.addProducer(STREAMER, StreamKind.SCREEN, makeProducer('screen-producer-1'));
		await watch('screen-1');

		runtime.removeProducer(STREAMER, StreamKind.SCREEN, { recoverable: true });
		runtime.addProducer(STREAMER, StreamKind.SCREEN, makeProducer('screen-producer-2'));
		await watch('screen-2');

		// The restored share restates its viewer silently for the streamer's
		// rebuilt list; the viewer's rewatch itself makes no cue.
		expect(watcherActions()).toEqual(['joined', 'sync']);

		runtime.removeProducer(STREAMER, StreamKind.SCREEN);
		runtime.addProducer(STREAMER, StreamKind.SCREEN, makeProducer('screen-producer-3'));
		await watch('screen-3');

		expect(watcherActions()).toEqual(['joined', 'sync', 'joined']);
	});

	test('webcam viewers keep watching across a webcam toggle', async () => {
		const { runtime, watcherActions, watch } = await setup();

		runtime.addProducer(STREAMER, StreamKind.VIDEO, makeProducer('video-producer-1'));
		await watch('video-1', StreamKind.VIDEO);

		runtime.removeProducer(STREAMER, StreamKind.VIDEO);
		runtime.addProducer(STREAMER, StreamKind.VIDEO, makeProducer('video-producer-2'));
		await watch('video-2', StreamKind.VIDEO);

		expect(watcherActions()).toEqual(['joined']);
	});
});
