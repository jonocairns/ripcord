import { describe, expect, it } from 'bun:test';
import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import {
	isConsumeCommandRunnable,
	markRemoteConsumeFailed,
	markRemoteConsumerClosed,
	markRemoteConsumeStarted,
	markRemoteConsumeSucceeded,
	markRemoteProducerClosed,
	markRemoteProducerPresent,
	markRemoteRetryRequested,
	markRemoteWatchRequested,
	markRemoteWatchStopped,
	reconcileRemoteMediaWithProducerSnapshot,
	refreshRemoteMediaPendingAges,
	remoteMediaState,
	remoteMediaSubscriptionsToPendingStreams,
	remoteMediaSubscriptionsToRepairScheduleCommand,
	remoteMediaSubscriptionsToStreamsToConsume,
	remoteMediaSubscriptionsToVisibleRemoteMedia,
	type TRemoteMediaSubscriptions,
	type TStreamsToConsumeCommand,
} from '../hooks/remote-media-subscriptions';
import { getPendingStreamKey } from '../hooks/use-pending-streams';

const makeProducers = (overrides: Partial<TRemoteProducerIds> = {}): TRemoteProducerIds => ({
	remoteAudioIds: [],
	remoteVideoIds: [],
	remoteScreenIds: [],
	remoteScreenAudioIds: [],
	remoteExternalStreamIds: [],
	...overrides,
});

describe('remote media subscriptions', () => {
	it('auto-desires audio but leaves watch-on-demand streams available', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer'));
		state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer'));

		expect(state.get(getPendingStreamKey(1, StreamKind.AUDIO))).toMatchObject({
			desired: true,
			status: 'wanted',
			producerId: 'audio-producer',
		});
		expect(state.get(getPendingStreamKey(2, StreamKind.VIDEO))).toMatchObject({
			desired: false,
			status: 'available',
			producerId: 'video-producer',
		});
	});

	it('preserves failed desired state after consume exhaustion', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
		state = remoteMediaState(markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 110, 'screen-producer'));
		state = remoteMediaState(markRemoteConsumeFailed(state, 3, StreamKind.SCREEN, 200, 'consume failed'));

		expect(state.get(getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
			desired: true,
			producerPresent: true,
			status: 'failed',
			lastFailureReason: 'consume failed',
		});
	});

	it('moves a failed desired slot into retrying with a new consume generation', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
		state = remoteMediaState(markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 1));
		state = remoteMediaState(markRemoteConsumeFailed(state, 3, StreamKind.SCREEN, 200, 'consume failed', 1));
		state = remoteMediaState(markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 220, 'screen-producer', 2, true));

		const key = getPendingStreamKey(3, StreamKind.SCREEN);

		expect(state.get(key)).toMatchObject({
			desired: true,
			producerPresent: true,
			status: 'retrying',
			consumeGeneration: 2,
			lastFailureReason: undefined,
			lastFailureAt: undefined,
		});
		expect(remoteMediaSubscriptionsToVisibleRemoteMedia(state)).toContainEqual(
			expect.objectContaining({
				key,
				status: 'retrying',
				subscriptionStatus: 'retrying',
			}),
		);
	});

	it('ignores stale consume results from an older retry generation', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
		state = remoteMediaState(markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 1));
		state = remoteMediaState(markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 120, 'screen-producer', 2, true));

		const afterStaleFailure = markRemoteConsumeFailed(state, 3, StreamKind.SCREEN, 130, 'stale failure', 1);

		expect(afterStaleFailure.state).toBe(state);
		expect(afterStaleFailure.state.get(getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
			status: 'retrying',
			consumeGeneration: 2,
		});

		const afterStaleSuccess = markRemoteConsumeSucceeded(
			state,
			3,
			StreamKind.SCREEN,
			140,
			'screen-producer',
			'stale-consumer',
			1,
		);

		expect(afterStaleSuccess.state).toBe(state);
		expect(afterStaleSuccess.state.get(getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
			status: 'retrying',
			consumerId: undefined,
			consumeGeneration: 2,
		});
	});

	it('ignores generated consume success after watch intent is stopped', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
		state = remoteMediaState(markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 1));
		state = remoteMediaState(markRemoteWatchStopped(state, 3, StreamKind.SCREEN, 120));

		const afterStaleSuccess = markRemoteConsumeSucceeded(
			state,
			3,
			StreamKind.SCREEN,
			130,
			'screen-producer',
			'stale-consumer',
			1,
		);

		expect(afterStaleSuccess.state).toBe(state);
		expect(afterStaleSuccess.state.get(getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
			desired: false,
			status: 'available',
			consumerId: undefined,
			consumeGeneration: undefined,
		});
	});

	it('keeps a failed desired webcam slot visible after its producer disappears', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.VIDEO, 100, 'video-producer'));
		state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.VIDEO, 110));
		state = remoteMediaState(markRemoteConsumeFailed(state, 3, StreamKind.VIDEO, 120, 'consume failed'));
		state = remoteMediaState(markRemoteProducerClosed(state, 3, StreamKind.VIDEO, 130, 'video-producer'));

		const key = getPendingStreamKey(3, StreamKind.VIDEO);

		expect(remoteMediaSubscriptionsToPendingStreams(state).has(key)).toBe(false);
		expect(remoteMediaSubscriptionsToVisibleRemoteMedia(state)).toContainEqual({
			key,
			remoteId: 3,
			kind: StreamKind.VIDEO,
			status: 'failed',
			subscriptionStatus: 'failed',
			producerPresent: false,
			desired: true,
			producerId: undefined,
		});
	});

	it('keeps an explicitly desired failed screen slot visible even without media objects', () => {
		const key = getPendingStreamKey(4, StreamKind.SCREEN);
		const state: TRemoteMediaSubscriptions = new Map([
			[
				key,
				{
					key,
					remoteId: 4,
					kind: StreamKind.SCREEN,
					producerPresent: false,
					desired: true,
					status: 'failed',
					updatedAt: 100,
					lastFailureAt: 100,
					lastFailureReason: 'consume failed',
				},
			],
		]);

		expect(remoteMediaSubscriptionsToPendingStreams(state).has(key)).toBe(false);
		expect(remoteMediaSubscriptionsToVisibleRemoteMedia(state)).toContainEqual(
			expect.objectContaining({
				key,
				remoteId: 4,
				kind: StreamKind.SCREEN,
				status: 'failed',
				subscriptionStatus: 'failed',
				producerPresent: false,
				desired: true,
			}),
		);
	});

	it('stop-watch turns a desired stream back into an available producer slot', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer'));
		state = remoteMediaState(markRemoteWatchRequested(state, 2, StreamKind.VIDEO, 110));
		state = remoteMediaState(markRemoteWatchStopped(state, 2, StreamKind.VIDEO, 120));

		expect(state.get(getPendingStreamKey(2, StreamKind.VIDEO))).toMatchObject({
			desired: false,
			producerPresent: true,
			status: 'available',
		});
	});

	it('ignores stale producer close events when producer identity has changed', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'new-producer'));
		state = remoteMediaState(markRemoteProducerClosed(state, 2, StreamKind.VIDEO, 110, 'old-producer'));

		expect(state.get(getPendingStreamKey(2, StreamKind.VIDEO))).toMatchObject({
			producerPresent: true,
			producerId: 'new-producer',
		});
	});

	it('clears screen-audio desire when the screen producer closes', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN_AUDIO, 100, 'audio-producer'));
		state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.SCREEN, 110));
		state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.SCREEN_AUDIO, 110));
		state = remoteMediaState(markRemoteProducerClosed(state, 3, StreamKind.SCREEN, 120, 'screen-producer'));

		expect(state.get(getPendingStreamKey(3, StreamKind.SCREEN_AUDIO))).toMatchObject({
			desired: false,
			producerPresent: true,
			status: 'available',
		});
	});

	it('keeps screen-audio desire through audio producer churn while screen remains watched', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN_AUDIO, 100, 'audio-producer'));
		state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.SCREEN, 110));
		state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.SCREEN_AUDIO, 110));
		state = remoteMediaState(markRemoteProducerClosed(state, 3, StreamKind.SCREEN_AUDIO, 120, 'audio-producer'));

		expect(state.get(getPendingStreamKey(3, StreamKind.SCREEN_AUDIO))).toMatchObject({
			desired: true,
			producerPresent: false,
			status: 'failed',
		});
		expect(remoteMediaSubscriptionsToVisibleRemoteMedia(state)).toContainEqual(
			expect.objectContaining({
				key: getPendingStreamKey(3, StreamKind.SCREEN_AUDIO),
				status: 'failed',
				desired: true,
				producerPresent: false,
			}),
		);
	});

	it('reconciles snapshot producer refs and derives pending streams from ledger state', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(
			reconcileRemoteMediaWithProducerSnapshot(
				state,
				makeProducers({
					remoteAudioProducers: [{ remoteId: 1, producerId: 'audio-producer' }],
					remoteScreenProducers: [{ remoteId: 3, producerId: 'screen-producer' }],
					remoteExternalAudioProducers: [{ streamId: 50, producerId: 'external-audio-producer' }],
				}),
				undefined,
				100,
			),
		);
		state = remoteMediaState(
			markRemoteConsumeSucceeded(state, 1, StreamKind.AUDIO, 110, 'audio-producer', 'consumer-1'),
		);

		const pendingStreams = remoteMediaSubscriptionsToPendingStreams(state);

		expect(pendingStreams.has(getPendingStreamKey(1, StreamKind.AUDIO))).toBe(false);
		expect(pendingStreams.get(getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
			remoteId: 3,
			kind: StreamKind.SCREEN,
			producerId: 'screen-producer',
		});
		expect(pendingStreams.get(getPendingStreamKey(50, StreamKind.EXTERNAL_AUDIO))).toMatchObject({
			remoteId: 50,
			kind: StreamKind.EXTERNAL_AUDIO,
			producerId: 'external-audio-producer',
		});
	});

	it('derives visible remote media states from ledger status', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer'));
		state = remoteMediaState(
			markRemoteConsumeSucceeded(state, 1, StreamKind.AUDIO, 110, 'audio-producer', 'consumer-1'),
		);
		state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer'));
		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
		state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.SCREEN, 110));
		state = remoteMediaState(markRemoteConsumeFailed(state, 3, StreamKind.SCREEN, 120, 'consume failed'));

		const visibleRemoteMedia = remoteMediaSubscriptionsToVisibleRemoteMedia(state);

		expect(visibleRemoteMedia.find((slot) => slot.key === getPendingStreamKey(1, StreamKind.AUDIO))).toMatchObject({
			status: 'live',
			subscriptionStatus: 'consumed',
		});
		expect(visibleRemoteMedia.find((slot) => slot.key === getPendingStreamKey(2, StreamKind.VIDEO))).toMatchObject({
			status: 'pending',
			subscriptionStatus: 'available',
		});
		expect(visibleRemoteMedia.find((slot) => slot.key === getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
			status: 'failed',
			subscriptionStatus: 'failed',
		});
	});

	it('keeps failed screen audio visible beside a live screen slot', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN_AUDIO, 100, 'audio-producer'));
		state = remoteMediaState(
			markRemoteConsumeSucceeded(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 'screen-consumer'),
		);
		state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.SCREEN_AUDIO, 120));
		state = remoteMediaState(markRemoteConsumeFailed(state, 3, StreamKind.SCREEN_AUDIO, 130, 'consume failed'));

		const visibleRemoteMedia = remoteMediaSubscriptionsToVisibleRemoteMedia(state);

		expect(visibleRemoteMedia.find((slot) => slot.key === getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
			status: 'live',
			subscriptionStatus: 'consumed',
		});
		expect(
			visibleRemoteMedia.find((slot) => slot.key === getPendingStreamKey(3, StreamKind.SCREEN_AUDIO)),
		).toMatchObject({
			status: 'failed',
			subscriptionStatus: 'failed',
			desired: true,
			producerPresent: true,
		});
	});

	it('retries failed screen audio while the screen video remains live', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
		state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN_AUDIO, 100, 'audio-producer'));
		state = remoteMediaState(markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 105, 'screen-producer', 1));
		state = remoteMediaState(
			markRemoteConsumeSucceeded(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 'screen-consumer', 1),
		);
		state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.SCREEN_AUDIO, 120));
		state = remoteMediaState(markRemoteConsumeFailed(state, 3, StreamKind.SCREEN_AUDIO, 130, 'consume failed'));
		state = remoteMediaState(
			markRemoteConsumeStarted(state, 3, StreamKind.SCREEN_AUDIO, 140, 'audio-producer', 2, true),
		);

		expect(state.get(getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
			status: 'consumed',
			consumerId: 'screen-consumer',
		});
		expect(state.get(getPendingStreamKey(3, StreamKind.SCREEN_AUDIO))).toMatchObject({
			desired: true,
			status: 'retrying',
			consumeGeneration: 2,
			producerPresent: true,
		});
	});

	it('returns a consumed slot to a repair-eligible pending state when its consumer closes', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer'));
		state = remoteMediaState(markRemoteConsumeStarted(state, 1, StreamKind.AUDIO, 110, 'audio-producer'));
		state = remoteMediaState(
			markRemoteConsumeSucceeded(state, 1, StreamKind.AUDIO, 120, 'audio-producer', 'consumer-1'),
		);
		state = remoteMediaState(markRemoteConsumerClosed(state, 1, StreamKind.AUDIO, 200, 'consumer-1'));

		const key = getPendingStreamKey(1, StreamKind.AUDIO);

		expect(state.get(key)).toMatchObject({
			status: 'wanted',
			desired: true,
			producerPresent: true,
			consumerId: undefined,
			pendingSince: 200,
		});
		expect(remoteMediaSubscriptionsToPendingStreams(state).get(key)).toMatchObject({
			remoteId: 1,
			kind: StreamKind.AUDIO,
			createdAt: 200,
		});
	});

	it('resets a consumed slot and tears down its consumer when the producer is replaced', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'producer-a'));
		state = remoteMediaState(markRemoteConsumeStarted(state, 1, StreamKind.AUDIO, 110, 'producer-a'));
		state = remoteMediaState(markRemoteConsumeSucceeded(state, 1, StreamKind.AUDIO, 120, 'producer-a', 'consumer-a'));

		const key = getPendingStreamKey(1, StreamKind.AUDIO);

		// A snapshot reporting a replacement producer with no matching close event
		// must not leave the slot stranded on the dead consumer for producer-a.
		const replaced = markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 200, 'producer-b');

		expect(replaced.state.get(key)).toMatchObject({
			status: 'wanted',
			desired: true,
			producerPresent: true,
			producerId: 'producer-b',
			consumerId: undefined,
		});
		expect(replaced.commands).toContainEqual({
			type: 'closeConsumer',
			key,
			remoteId: 1,
			kind: StreamKind.AUDIO,
			consumerId: 'consumer-a',
			generation: undefined,
		});
		// The replacement producer re-enters the pending map so it actually gets consumed.
		expect(remoteMediaSubscriptionsToPendingStreams(replaced.state).get(key)).toMatchObject({
			producerId: 'producer-b',
		});
	});

	it('reconciles a replaced producer through the snapshot path', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'producer-a'));
		state = remoteMediaState(markRemoteConsumeStarted(state, 1, StreamKind.AUDIO, 110, 'producer-a'));
		state = remoteMediaState(markRemoteConsumeSucceeded(state, 1, StreamKind.AUDIO, 120, 'producer-a', 'consumer-a'));

		const key = getPendingStreamKey(1, StreamKind.AUDIO);
		const reconciled = reconcileRemoteMediaWithProducerSnapshot(
			state,
			makeProducers({ remoteAudioProducers: [{ remoteId: 1, producerId: 'producer-b' }] }),
			undefined,
			200,
		);

		expect(reconciled.state.get(key)).toMatchObject({
			status: 'wanted',
			producerId: 'producer-b',
			consumerId: undefined,
		});
		expect(reconciled.commands).toContainEqual({
			type: 'closeConsumer',
			key,
			remoteId: 1,
			kind: StreamKind.AUDIO,
			consumerId: 'consumer-a',
			generation: undefined,
		});
	});

	it('ignores consumer-close events that do not match the ledger consumer', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer'));
		state = remoteMediaState(markRemoteConsumeStarted(state, 1, StreamKind.AUDIO, 110, 'audio-producer'));
		state = remoteMediaState(
			markRemoteConsumeSucceeded(state, 1, StreamKind.AUDIO, 120, 'audio-producer', 'consumer-2'),
		);

		const afterStaleClose = markRemoteConsumerClosed(state, 1, StreamKind.AUDIO, 200, 'consumer-1');

		expect(afterStaleClose.state).toBe(state);
		expect(afterStaleClose.state.get(getPendingStreamKey(1, StreamKind.AUDIO))).toMatchObject({
			status: 'consumed',
			consumerId: 'consumer-2',
		});
	});

	it('leaves an in-flight consuming slot alone when a replaced consumer closes', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer'));
		state = remoteMediaState(markRemoteConsumeStarted(state, 1, StreamKind.AUDIO, 110, 'audio-producer'));

		const afterClose = markRemoteConsumerClosed(state, 1, StreamKind.AUDIO, 200, 'consumer-1');

		expect(afterClose.state).toBe(state);
		expect(afterClose.state.get(getPendingStreamKey(1, StreamKind.AUDIO))).toMatchObject({
			status: 'consuming',
		});
	});

	it('returns the same map reference when reconciliation changes nothing material', () => {
		const producers = makeProducers({
			remoteAudioProducers: [{ remoteId: 1, producerId: 'audio-producer' }],
			remoteScreenProducers: [{ remoteId: 3, producerId: 'screen-producer' }],
		});
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(reconcileRemoteMediaWithProducerSnapshot(state, producers, undefined, 100));

		const reconciledAgain = reconcileRemoteMediaWithProducerSnapshot(state, producers, undefined, 200);
		const presentAgain = markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 300, 'audio-producer');

		expect(reconciledAgain.state).toBe(state);
		expect(presentAgain.state).toBe(state);
	});

	it('refreshes pending ages for available entries so repair backoff always widens', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer'));
		state = refreshRemoteMediaPendingAges(state, 500);

		expect(state.get(getPendingStreamKey(2, StreamKind.VIDEO))).toMatchObject({
			status: 'available',
			pendingSince: 500,
		});
	});

	describe('command envelope', () => {
		it('emits a consume command when watch intent meets consume guards', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(
				markRemoteProducerPresent(state, 50, StreamKind.EXTERNAL_AUDIO, 100, 'external-audio-producer', {
					externalStreamTracks: { 50: { audio: true } },
				}),
			);
			const result = markRemoteWatchRequested(state, 50, StreamKind.EXTERNAL_AUDIO, 110, {
				externalStreamTracks: { 50: { audio: true } },
			});

			expect(result.commands).toEqual([
				{
					type: 'consume',
					key: getPendingStreamKey(50, StreamKind.EXTERNAL_AUDIO),
					remoteId: 50,
					kind: StreamKind.EXTERNAL_AUDIO,
					producerId: 'external-audio-producer',
					generation: 1,
				},
			]);
		});

		it('does not emit consume commands for external streams without current track metadata', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(
				markRemoteProducerPresent(state, 50, StreamKind.EXTERNAL_AUDIO, 100, 'external-audio-producer'),
			);
			const result = markRemoteWatchRequested(state, 50, StreamKind.EXTERNAL_AUDIO, 110);

			expect(result.commands).toEqual([]);
		});

		it('emits a manual-retry consume command with the current producer id', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
			state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.SCREEN, 110));
			state = remoteMediaState(markRemoteConsumeFailed(state, 3, StreamKind.SCREEN, 120, 'consume failed'));

			const result = markRemoteRetryRequested(state, 3, StreamKind.SCREEN, 130);

			expect(result.state.get(getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
				status: 'retrying',
				lastFailureReason: undefined,
			});
			expect(result.commands).toEqual([
				{
					type: 'consume',
					key: getPendingStreamKey(3, StreamKind.SCREEN),
					remoteId: 3,
					kind: StreamKind.SCREEN,
					producerId: 'screen-producer',
					generation: 1,
					isManualRetry: true,
				},
			]);
		});

		it('emits a close-consumer command when watch intent stops a consumed stream', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer'));
			state = remoteMediaState(markRemoteWatchRequested(state, 2, StreamKind.VIDEO, 105));
			state = remoteMediaState(markRemoteConsumeStarted(state, 2, StreamKind.VIDEO, 110, 'video-producer', 1));
			state = remoteMediaState(
				markRemoteConsumeSucceeded(state, 2, StreamKind.VIDEO, 120, 'video-producer', 'consumer-2', 1),
			);

			const result = markRemoteWatchStopped(state, 2, StreamKind.VIDEO, 130);

			expect(result.commands).toEqual([
				{
					type: 'closeConsumer',
					key: getPendingStreamKey(2, StreamKind.VIDEO),
					remoteId: 2,
					kind: StreamKind.VIDEO,
					consumerId: 'consumer-2',
					generation: undefined,
				},
			]);
		});

		it('emits screen-audio commands from screen watch cascades', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
			state = remoteMediaState(
				markRemoteProducerPresent(state, 3, StreamKind.SCREEN_AUDIO, 100, 'screen-audio-producer'),
			);

			const watchResult = markRemoteWatchRequested(state, 3, StreamKind.SCREEN, 110);

			expect(watchResult.commands).toContainEqual(
				expect.objectContaining({
					type: 'consume',
					key: getPendingStreamKey(3, StreamKind.SCREEN_AUDIO),
					remoteId: 3,
					kind: StreamKind.SCREEN_AUDIO,
					producerId: 'screen-audio-producer',
				}),
			);

			state = remoteMediaState(
				markRemoteConsumeStarted(watchResult.state, 3, StreamKind.SCREEN_AUDIO, 120, 'screen-audio-producer', 1),
			);
			state = remoteMediaState(
				markRemoteConsumeSucceeded(
					state,
					3,
					StreamKind.SCREEN_AUDIO,
					130,
					'screen-audio-producer',
					'screen-audio-consumer',
					1,
				),
			);

			const stopResult = markRemoteWatchStopped(state, 3, StreamKind.SCREEN, 140);

			expect(stopResult.commands).toContainEqual({
				type: 'closeConsumer',
				key: getPendingStreamKey(3, StreamKind.SCREEN_AUDIO),
				remoteId: 3,
				kind: StreamKind.SCREEN_AUDIO,
				consumerId: 'screen-audio-consumer',
				generation: undefined,
			});
		});

		it('preserves the screen-audio cascade when a screen consume is started directly', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			// A direct restore consume: the screen + its audio producers are present
			// but no markWatchRequested ran first (reconnect restore calls consume()
			// directly), so this call is the only place the screen-audio consume can
			// be minted.
			state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
			state = remoteMediaState(
				markRemoteProducerPresent(state, 3, StreamKind.SCREEN_AUDIO, 100, 'screen-audio-producer'),
			);

			const result = markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 1);

			// The discovered screen-audio consume is preserved...
			expect(result.commands).toContainEqual(
				expect.objectContaining({
					type: 'consume',
					key: getPendingStreamKey(3, StreamKind.SCREEN_AUDIO),
					remoteId: 3,
					kind: StreamKind.SCREEN_AUDIO,
					producerId: 'screen-audio-producer',
				}),
			);
			// ...while the command for the slot being started here is dropped (its
			// consume is already in flight via this call).
			expect(
				result.commands.some(
					(command) => command.type === 'consume' && command.key === getPendingStreamKey(3, StreamKind.SCREEN),
				),
			).toBe(false);
			expect(result.state.get(getPendingStreamKey(3, StreamKind.SCREEN))?.status).toBe('consuming');
		});

		it('does not emit close commands for stale consumer-close results', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer'));
			state = remoteMediaState(markRemoteConsumeStarted(state, 1, StreamKind.AUDIO, 110, 'audio-producer', 1));
			state = remoteMediaState(
				markRemoteConsumeSucceeded(state, 1, StreamKind.AUDIO, 120, 'audio-producer', 'consumer-2', 1),
			);

			const result = markRemoteConsumerClosed(state, 1, StreamKind.AUDIO, 130, 'consumer-1');

			expect(result.state).toBe(state);
			expect(result.commands).toEqual([]);
		});

		it('emits repair schedule commands at the expected retry time', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer'));
			const pendingStreams = remoteMediaSubscriptionsToPendingStreams(state);

			expect(remoteMediaSubscriptionsToRepairScheduleCommand(state, pendingStreams, {})).toEqual({
				type: 'scheduleRetry',
				key: 'remote-media-repair',
				retryAt: 15_100,
				generation: 100,
			});
		});
	});

	describe('consume command revalidation', () => {
		const consumeCommandFor = (
			state: TRemoteMediaSubscriptions,
			remoteId: number,
			kind: StreamKind,
			isManualRetry?: true,
		): TStreamsToConsumeCommand => ({
			type: 'consume',
			key: getPendingStreamKey(remoteId, kind),
			remoteId,
			kind,
			producerId: state.get(getPendingStreamKey(remoteId, kind))?.producerId,
			generation: 1,
			isManualRetry,
		});

		it('runs a consume whose slot is still wanted', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer'));
			state = remoteMediaState(markRemoteWatchRequested(state, 2, StreamKind.VIDEO, 110));

			expect(isConsumeCommandRunnable(state, consumeCommandFor(state, 2, StreamKind.VIDEO))).toBe(true);
		});

		it('skips a consume whose watch was stopped before it drained', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer'));
			state = remoteMediaState(markRemoteWatchRequested(state, 2, StreamKind.VIDEO, 110));
			const command = consumeCommandFor(state, 2, StreamKind.VIDEO);

			// The user stops watching while the command sits queued (rtpCapabilities
			// unavailable). Running it later would resurrect the stopped stream.
			state = remoteMediaState(markRemoteWatchStopped(state, 2, StreamKind.VIDEO, 120));

			expect(isConsumeCommandRunnable(state, command)).toBe(false);
		});

		it('skips a consume whose slot no longer exists', () => {
			const state: TRemoteMediaSubscriptions = new Map();

			expect(isConsumeCommandRunnable(state, { ...consumeCommandFor(state, 2, StreamKind.VIDEO) })).toBe(false);
		});

		it('skips a consume minted for a producer that was since replaced', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer-old'));
			state = remoteMediaState(markRemoteWatchRequested(state, 2, StreamKind.VIDEO, 110));
			const command = consumeCommandFor(state, 2, StreamKind.VIDEO);
			expect(command.producerId).toBe('video-producer-old');

			// The producer is replaced (reconnect/repair) before the queued command
			// drains. Running the stale command would re-stamp the ledger with the
			// dead producer id and tear down the live consumer.
			state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 120, 'video-producer-new'));

			expect(state.get(getPendingStreamKey(2, StreamKind.VIDEO))?.producerId).toBe('video-producer-new');
			expect(isConsumeCommandRunnable(state, command)).toBe(false);
			// A command carrying the current producer id still runs.
			expect(isConsumeCommandRunnable(state, consumeCommandFor(state, 2, StreamKind.VIDEO))).toBe(true);
		});

		it('only runs a manual-retry consume against a retrying slot', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
			state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.SCREEN, 110));

			// A manual-retry command against a 'wanted' (not 'retrying') slot is stale.
			expect(isConsumeCommandRunnable(state, consumeCommandFor(state, 3, StreamKind.SCREEN, true))).toBe(false);

			state = remoteMediaState(markRemoteConsumeFailed(state, 3, StreamKind.SCREEN, 120, 'consume failed'));
			state = remoteMediaState(markRemoteRetryRequested(state, 3, StreamKind.SCREEN, 130));

			expect(isConsumeCommandRunnable(state, consumeCommandFor(state, 3, StreamKind.SCREEN, true))).toBe(true);
		});
	});

	describe('streams to consume selector', () => {
		it('emits desired external tracks with live producers and current track metadata', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(
				markRemoteProducerPresent(state, 50, StreamKind.EXTERNAL_AUDIO, 100, 'external-audio-producer'),
			);
			state = remoteMediaState(
				markRemoteProducerPresent(state, 50, StreamKind.EXTERNAL_VIDEO, 100, 'external-video-producer'),
			);
			state = remoteMediaState(markRemoteWatchRequested(state, 50, StreamKind.EXTERNAL_AUDIO, 110));
			state = remoteMediaState(markRemoteWatchRequested(state, 50, StreamKind.EXTERNAL_VIDEO, 110));

			expect(remoteMediaSubscriptionsToStreamsToConsume(state, { 50: { audio: true, video: true } })).toEqual([
				{
					type: 'consume',
					key: getPendingStreamKey(50, StreamKind.EXTERNAL_AUDIO),
					remoteId: 50,
					kind: StreamKind.EXTERNAL_AUDIO,
					producerId: 'external-audio-producer',
					generation: 1,
				},
				{
					type: 'consume',
					key: getPendingStreamKey(50, StreamKind.EXTERNAL_VIDEO),
					remoteId: 50,
					kind: StreamKind.EXTERNAL_VIDEO,
					producerId: 'external-video-producer',
					generation: 1,
				},
			]);
		});

		it('does not emit external commands without current track metadata', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(
				markRemoteProducerPresent(state, 50, StreamKind.EXTERNAL_AUDIO, 100, 'external-audio-producer'),
			);
			state = remoteMediaState(markRemoteWatchRequested(state, 50, StreamKind.EXTERNAL_AUDIO, 110));

			expect(remoteMediaSubscriptionsToStreamsToConsume(state)).toEqual([]);
			expect(remoteMediaSubscriptionsToStreamsToConsume(state, { 50: { audio: false } })).toEqual([]);
		});

		it('emits desired screen audio while the screen video is live', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
			state = remoteMediaState(markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 105, 'screen-producer', 1));
			state = remoteMediaState(
				markRemoteConsumeSucceeded(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 'screen-consumer', 1),
			);
			state = remoteMediaState(
				markRemoteProducerPresent(state, 3, StreamKind.SCREEN_AUDIO, 120, 'screen-audio-producer'),
			);

			expect(remoteMediaSubscriptionsToStreamsToConsume(state)).toContainEqual({
				type: 'consume',
				key: getPendingStreamKey(3, StreamKind.SCREEN_AUDIO),
				remoteId: 3,
				kind: StreamKind.SCREEN_AUDIO,
				producerId: 'screen-audio-producer',
				generation: 1,
			});

			state = remoteMediaState(markRemoteProducerClosed(state, 3, StreamKind.SCREEN, 120, 'screen-producer'));

			expect(remoteMediaSubscriptionsToStreamsToConsume(state)).not.toContainEqual(
				expect.objectContaining({
					key: getPendingStreamKey(3, StreamKind.SCREEN_AUDIO),
				}),
			);
		});

		it('does not duplicate in-flight, retrying, failed, or consumed slots', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer'));
			state = remoteMediaState(markRemoteConsumeStarted(state, 1, StreamKind.AUDIO, 110, 'audio-producer', 1));
			state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer'));
			state = remoteMediaState(markRemoteWatchRequested(state, 2, StreamKind.VIDEO, 110));
			state = remoteMediaState(markRemoteConsumeStarted(state, 2, StreamKind.VIDEO, 120, 'video-producer', 2, true));
			state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
			state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.SCREEN, 110));
			state = remoteMediaState(markRemoteConsumeFailed(state, 3, StreamKind.SCREEN, 120, 'consume failed'));
			state = remoteMediaState(markRemoteProducerPresent(state, 4, StreamKind.AUDIO, 100, 'other-audio-producer'));
			state = remoteMediaState(
				markRemoteConsumeSucceeded(state, 4, StreamKind.AUDIO, 110, 'other-audio-producer', 'consumer-4'),
			);

			expect(remoteMediaSubscriptionsToStreamsToConsume(state)).toEqual([]);
		});

		it('does not emit when producer is absent or watch intent has stopped', () => {
			let state: TRemoteMediaSubscriptions = new Map();

			state = remoteMediaState(markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer'));
			state = remoteMediaState(markRemoteWatchRequested(state, 2, StreamKind.VIDEO, 110));
			state = remoteMediaState(markRemoteProducerClosed(state, 2, StreamKind.VIDEO, 120, 'video-producer'));
			state = remoteMediaState(markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer'));
			state = remoteMediaState(markRemoteWatchRequested(state, 3, StreamKind.SCREEN, 110));
			state = remoteMediaState(markRemoteWatchStopped(state, 3, StreamKind.SCREEN, 120));

			expect(remoteMediaSubscriptionsToStreamsToConsume(state)).toEqual([]);
		});
	});

	describe('screen-audio desire couples to the screen', () => {
		it('grants screen-audio desire when audio appears after the screen is watched', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = remoteMediaState(markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p'));
			state = remoteMediaState(markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110));
			state = remoteMediaState(markRemoteProducerPresent(state, 5, StreamKind.SCREEN_AUDIO, 120, 'audio-p'));

			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))).toMatchObject({
				desired: true,
				producerPresent: true,
				status: 'wanted',
			});
		});

		it('grants screen-audio desire when the audio producer already exists at accept', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = remoteMediaState(markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p'));
			state = remoteMediaState(markRemoteProducerPresent(state, 5, StreamKind.SCREEN_AUDIO, 100, 'audio-p'));
			state = remoteMediaState(markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110));

			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))?.desired).toBe(true);
		});

		it('does not fabricate a pending screen-audio card before its producer exists', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = remoteMediaState(markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p'));
			state = remoteMediaState(markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110));

			expect(state.has(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))).toBe(false);
			expect(remoteMediaSubscriptionsToPendingStreams(state).has(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))).toBe(
				false,
			);
		});

		it('revokes screen-audio desire when the screen is un-watched', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = remoteMediaState(markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p'));
			state = remoteMediaState(markRemoteProducerPresent(state, 5, StreamKind.SCREEN_AUDIO, 100, 'audio-p'));
			state = remoteMediaState(markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110));
			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))?.desired).toBe(true);

			state = remoteMediaState(markRemoteWatchStopped(state, 5, StreamKind.SCREEN, 120));
			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))?.desired).toBe(false);
		});

		it('does not re-grant screen-audio desire on reconcile once the screen is un-watched', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = remoteMediaState(markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p'));
			state = remoteMediaState(markRemoteProducerPresent(state, 5, StreamKind.SCREEN_AUDIO, 100, 'audio-p'));
			state = remoteMediaState(markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110));
			state = remoteMediaState(markRemoteWatchStopped(state, 5, StreamKind.SCREEN, 120));

			state = remoteMediaState(
				reconcileRemoteMediaWithProducerSnapshot(
					state,
					makeProducers({ remoteScreenIds: [5], remoteScreenAudioIds: [5] }),
					undefined,
					130,
				),
			);

			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))?.desired).toBe(false);
		});

		it('drops screen-audio desire when the screen producer closes', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = remoteMediaState(markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p'));
			state = remoteMediaState(markRemoteProducerPresent(state, 5, StreamKind.SCREEN_AUDIO, 100, 'audio-p'));
			state = remoteMediaState(markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110));

			state = remoteMediaState(markRemoteProducerClosed(state, 5, StreamKind.SCREEN, 120, 'screen-p'));

			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))?.desired).toBe(false);
		});
	});
});
