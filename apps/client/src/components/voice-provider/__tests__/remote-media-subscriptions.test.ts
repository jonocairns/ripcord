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

	it('refreshes pending ages for available entries so repair backoff always widens', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = markRemoteProducerPresent(state, 2, StreamKind.VIDEO, 100, 'video-producer');
		state = refreshRemoteMediaPendingAges(state, 500);

		expect(state.get(getPendingStreamKey(2, StreamKind.VIDEO))).toMatchObject({
			status: 'available',
			pendingSince: 500,
		});
	});
});
