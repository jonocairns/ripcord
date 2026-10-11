import { describe, expect, it } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import {
	clearRemoteMediaProducerStateForTransportCleanup,
	markRemoteProducerClosed,
	markRemoteProducerPresent,
	markRemoteWatchRequested,
	type TRemoteMediaSubscriptions,
} from '../remote-media-subscriptions';
import { getWatchIntentEvents } from '../watch-intent-observability';

describe('committed watch intent telemetry', () => {
	it('distinguishes retained watch intent on recoverable close from revoked terminal intent', () => {
		const empty: TRemoteMediaSubscriptions = new Map();
		const present = markRemoteProducerPresent(empty, 2, StreamKind.SCREEN, 0, 'producer-2').state;
		const watched = markRemoteWatchRequested(present, 2, StreamKind.SCREEN, 1).state;
		const recoverable = markRemoteProducerClosed(watched, 2, StreamKind.SCREEN, 2, 'producer-2', {
			preserveDesired: true,
		}).state;
		expect(getWatchIntentEvents(watched, recoverable)).toMatchObject([
			{ event: 'watch_intent_retained', desired: true, producerId: 'producer-2' },
		]);
		const terminal = markRemoteProducerClosed(watched, 2, StreamKind.SCREEN, 2, 'producer-2').state;
		expect(getWatchIntentEvents(watched, terminal)).toMatchObject([{ event: 'watch_intent_cleared', desired: false }]);
		const transportCleanup = clearRemoteMediaProducerStateForTransportCleanup(watched, 2);
		expect(getWatchIntentEvents(watched, transportCleanup)).toMatchObject([{ event: 'watch_intent_retained' }]);
		expect(getWatchIntentEvents(recoverable, recoverable)).toEqual([]);
	});
});
