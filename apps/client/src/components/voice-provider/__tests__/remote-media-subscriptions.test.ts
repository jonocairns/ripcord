import { describe, expect, it } from 'bun:test';
import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import {
	markRemoteConsumeFailed,
	markRemoteConsumeStarted,
	markRemoteConsumeSucceeded,
	markRemoteConsumerClosed,
	markRemoteProducerClosed,
	markRemoteProducerPresent,
	markRemoteWatchRequested,
	markRemoteWatchStopped,
	reconcileRemoteMediaWithProducerSnapshot,
	refreshRemoteMediaPendingAges,
	remoteMediaSubscriptionsToPendingStreams,
	remoteMediaSubscriptionsToVisibleRemoteMedia,
	type TRemoteMediaSubscriptions,
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

		state = markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer');
		state = markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer');

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

		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer');
		state = markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 110, 'screen-producer');
		state = markRemoteConsumeFailed(state, 3, StreamKind.SCREEN, 200, 'consume failed');

		expect(state.get(getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
			desired: true,
			producerPresent: true,
			status: 'failed',
			lastFailureReason: 'consume failed',
		});
	});

	it('moves a failed desired slot into retrying with a new consume generation', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer');
		state = markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 1);
		state = markRemoteConsumeFailed(state, 3, StreamKind.SCREEN, 200, 'consume failed', 1);
		state = markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 220, 'screen-producer', 2, true);

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

		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer');
		state = markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 1);
		state = markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 120, 'screen-producer', 2, true);

		const afterStaleFailure = markRemoteConsumeFailed(state, 3, StreamKind.SCREEN, 130, 'stale failure', 1);

		expect(afterStaleFailure).toBe(state);
		expect(afterStaleFailure.get(getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
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

		expect(afterStaleSuccess).toBe(state);
		expect(afterStaleSuccess.get(getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
			status: 'retrying',
			consumerId: undefined,
			consumeGeneration: 2,
		});
	});

	it('ignores generated consume success after watch intent is stopped', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer');
		state = markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 1);
		state = markRemoteWatchStopped(state, 3, StreamKind.SCREEN, 120);

		const afterStaleSuccess = markRemoteConsumeSucceeded(
			state,
			3,
			StreamKind.SCREEN,
			130,
			'screen-producer',
			'stale-consumer',
			1,
		);

		expect(afterStaleSuccess).toBe(state);
		expect(afterStaleSuccess.get(getPendingStreamKey(3, StreamKind.SCREEN))).toMatchObject({
			desired: false,
			status: 'available',
			consumerId: undefined,
			consumeGeneration: undefined,
		});
	});

	it('keeps a failed desired webcam slot visible after its producer disappears', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = markRemoteProducerPresent(state, 3, StreamKind.VIDEO, 100, 'video-producer');
		state = markRemoteWatchRequested(state, 3, StreamKind.VIDEO, 110);
		state = markRemoteConsumeFailed(state, 3, StreamKind.VIDEO, 120, 'consume failed');
		state = markRemoteProducerClosed(state, 3, StreamKind.VIDEO, 130, 'video-producer');

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

		state = markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer');
		state = markRemoteWatchRequested(state, 2, StreamKind.VIDEO, 110);
		state = markRemoteWatchStopped(state, 2, StreamKind.VIDEO, 120);

		expect(state.get(getPendingStreamKey(2, StreamKind.VIDEO))).toMatchObject({
			desired: false,
			producerPresent: true,
			status: 'available',
		});
	});

	it('ignores stale producer close events when producer identity has changed', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'new-producer');
		state = markRemoteProducerClosed(state, 2, StreamKind.VIDEO, 110, 'old-producer');

		expect(state.get(getPendingStreamKey(2, StreamKind.VIDEO))).toMatchObject({
			producerPresent: true,
			producerId: 'new-producer',
		});
	});

	it('clears screen-audio desire when the screen producer closes', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer');
		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN_AUDIO, 100, 'audio-producer');
		state = markRemoteWatchRequested(state, 3, StreamKind.SCREEN, 110);
		state = markRemoteWatchRequested(state, 3, StreamKind.SCREEN_AUDIO, 110);
		state = markRemoteProducerClosed(state, 3, StreamKind.SCREEN, 120, 'screen-producer');

		expect(state.get(getPendingStreamKey(3, StreamKind.SCREEN_AUDIO))).toMatchObject({
			desired: false,
			producerPresent: true,
			status: 'available',
		});
	});

	it('keeps screen-audio desire through audio producer churn while screen remains watched', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer');
		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN_AUDIO, 100, 'audio-producer');
		state = markRemoteWatchRequested(state, 3, StreamKind.SCREEN, 110);
		state = markRemoteWatchRequested(state, 3, StreamKind.SCREEN_AUDIO, 110);
		state = markRemoteProducerClosed(state, 3, StreamKind.SCREEN_AUDIO, 120, 'audio-producer');

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

		state = reconcileRemoteMediaWithProducerSnapshot(
			state,
			makeProducers({
				remoteAudioProducers: [{ remoteId: 1, producerId: 'audio-producer' }],
				remoteScreenProducers: [{ remoteId: 3, producerId: 'screen-producer' }],
				remoteExternalAudioProducers: [{ streamId: 50, producerId: 'external-audio-producer' }],
			}),
			undefined,
			100,
		);
		state = markRemoteConsumeSucceeded(state, 1, StreamKind.AUDIO, 110, 'audio-producer', 'consumer-1');

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

		state = markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer');
		state = markRemoteConsumeSucceeded(state, 1, StreamKind.AUDIO, 110, 'audio-producer', 'consumer-1');
		state = markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer');
		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer');
		state = markRemoteWatchRequested(state, 3, StreamKind.SCREEN, 110);
		state = markRemoteConsumeFailed(state, 3, StreamKind.SCREEN, 120, 'consume failed');

		const visibleRemoteMedia = remoteMediaSubscriptionsToVisibleRemoteMedia(state);

		expect(
			visibleRemoteMedia.find((slot) => slot.key === getPendingStreamKey(1, StreamKind.AUDIO)),
		).toMatchObject({
			status: 'live',
			subscriptionStatus: 'consumed',
		});
		expect(
			visibleRemoteMedia.find((slot) => slot.key === getPendingStreamKey(2, StreamKind.VIDEO)),
		).toMatchObject({
			status: 'pending',
			subscriptionStatus: 'available',
		});
		expect(
			visibleRemoteMedia.find((slot) => slot.key === getPendingStreamKey(3, StreamKind.SCREEN)),
		).toMatchObject({
			status: 'failed',
			subscriptionStatus: 'failed',
		});
	});

	it('keeps failed screen audio visible beside a live screen slot', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer');
		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN_AUDIO, 100, 'audio-producer');
		state = markRemoteConsumeSucceeded(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 'screen-consumer');
		state = markRemoteWatchRequested(state, 3, StreamKind.SCREEN_AUDIO, 120);
		state = markRemoteConsumeFailed(state, 3, StreamKind.SCREEN_AUDIO, 130, 'consume failed');

		const visibleRemoteMedia = remoteMediaSubscriptionsToVisibleRemoteMedia(state);

		expect(
			visibleRemoteMedia.find((slot) => slot.key === getPendingStreamKey(3, StreamKind.SCREEN)),
		).toMatchObject({
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

		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN, 100, 'screen-producer');
		state = markRemoteProducerPresent(state, 3, StreamKind.SCREEN_AUDIO, 100, 'audio-producer');
		state = markRemoteConsumeStarted(state, 3, StreamKind.SCREEN, 105, 'screen-producer', 1);
		state = markRemoteConsumeSucceeded(state, 3, StreamKind.SCREEN, 110, 'screen-producer', 'screen-consumer', 1);
		state = markRemoteWatchRequested(state, 3, StreamKind.SCREEN_AUDIO, 120);
		state = markRemoteConsumeFailed(state, 3, StreamKind.SCREEN_AUDIO, 130, 'consume failed');
		state = markRemoteConsumeStarted(state, 3, StreamKind.SCREEN_AUDIO, 140, 'audio-producer', 2, true);

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

		state = markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer');
		state = markRemoteConsumeStarted(state, 1, StreamKind.AUDIO, 110, 'audio-producer');
		state = markRemoteConsumeSucceeded(state, 1, StreamKind.AUDIO, 120, 'audio-producer', 'consumer-1');
		state = markRemoteConsumerClosed(state, 1, StreamKind.AUDIO, 200, 'consumer-1');

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

	it('ignores consumer-close events that do not match the ledger consumer', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer');
		state = markRemoteConsumeStarted(state, 1, StreamKind.AUDIO, 110, 'audio-producer');
		state = markRemoteConsumeSucceeded(state, 1, StreamKind.AUDIO, 120, 'audio-producer', 'consumer-2');

		const afterStaleClose = markRemoteConsumerClosed(state, 1, StreamKind.AUDIO, 200, 'consumer-1');

		expect(afterStaleClose).toBe(state);
		expect(afterStaleClose.get(getPendingStreamKey(1, StreamKind.AUDIO))).toMatchObject({
			status: 'consumed',
			consumerId: 'consumer-2',
		});
	});

	it('leaves an in-flight consuming slot alone when a replaced consumer closes', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 100, 'audio-producer');
		state = markRemoteConsumeStarted(state, 1, StreamKind.AUDIO, 110, 'audio-producer');

		const afterClose = markRemoteConsumerClosed(state, 1, StreamKind.AUDIO, 200, 'consumer-1');

		expect(afterClose).toBe(state);
		expect(afterClose.get(getPendingStreamKey(1, StreamKind.AUDIO))).toMatchObject({
			status: 'consuming',
		});
	});

	it('returns the same map reference when reconciliation changes nothing material', () => {
		const producers = makeProducers({
			remoteAudioProducers: [{ remoteId: 1, producerId: 'audio-producer' }],
			remoteScreenProducers: [{ remoteId: 3, producerId: 'screen-producer' }],
		});
		let state: TRemoteMediaSubscriptions = new Map();

		state = reconcileRemoteMediaWithProducerSnapshot(state, producers, undefined, 100);

		const reconciledAgain = reconcileRemoteMediaWithProducerSnapshot(state, producers, undefined, 200);
		const presentAgain = markRemoteProducerPresent(state, 1, StreamKind.AUDIO, 300, 'audio-producer');

		expect(reconciledAgain).toBe(state);
		expect(presentAgain).toBe(state);
	});

	it('refreshes pending ages for available entries so repair backoff always widens', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer');
		state = refreshRemoteMediaPendingAges(state, 500);

		expect(state.get(getPendingStreamKey(2, StreamKind.VIDEO))).toMatchObject({
			status: 'available',
			pendingSince: 500,
		});
	});

	describe('screen-audio desire couples to the screen', () => {
		it('grants screen-audio desire when audio appears after the screen is watched', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p');
			state = markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110);
			state = markRemoteProducerPresent(state, 5, StreamKind.SCREEN_AUDIO, 120, 'audio-p');

			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))).toMatchObject({
				desired: true,
				producerPresent: true,
				status: 'wanted',
			});
		});

		it('grants screen-audio desire when the audio producer already exists at accept', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p');
			state = markRemoteProducerPresent(state, 5, StreamKind.SCREEN_AUDIO, 100, 'audio-p');
			state = markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110);

			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))?.desired).toBe(true);
		});

		it('does not fabricate a pending screen-audio card before its producer exists', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p');
			state = markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110);

			expect(state.has(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))).toBe(false);
			expect(
				remoteMediaSubscriptionsToPendingStreams(state).has(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO)),
			).toBe(false);
		});

		it('revokes screen-audio desire when the screen is un-watched', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p');
			state = markRemoteProducerPresent(state, 5, StreamKind.SCREEN_AUDIO, 100, 'audio-p');
			state = markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110);
			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))?.desired).toBe(true);

			state = markRemoteWatchStopped(state, 5, StreamKind.SCREEN, 120);
			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))?.desired).toBe(false);
		});

		it('does not re-grant screen-audio desire on reconcile once the screen is un-watched', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p');
			state = markRemoteProducerPresent(state, 5, StreamKind.SCREEN_AUDIO, 100, 'audio-p');
			state = markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110);
			state = markRemoteWatchStopped(state, 5, StreamKind.SCREEN, 120);

			state = reconcileRemoteMediaWithProducerSnapshot(
				state,
				makeProducers({ remoteScreenIds: [5], remoteScreenAudioIds: [5] }),
				undefined,
				130,
			);

			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))?.desired).toBe(false);
		});

		it('drops screen-audio desire when the screen producer closes', () => {
			let state: TRemoteMediaSubscriptions = new Map();
			state = markRemoteProducerPresent(state, 5, StreamKind.SCREEN, 100, 'screen-p');
			state = markRemoteProducerPresent(state, 5, StreamKind.SCREEN_AUDIO, 100, 'audio-p');
			state = markRemoteWatchRequested(state, 5, StreamKind.SCREEN, 110);

			state = markRemoteProducerClosed(state, 5, StreamKind.SCREEN, 120, 'screen-p');

			expect(state.get(getPendingStreamKey(5, StreamKind.SCREEN_AUDIO))?.desired).toBe(false);
		});
	});
});
