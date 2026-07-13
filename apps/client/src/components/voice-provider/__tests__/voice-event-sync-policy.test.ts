import { describe, expect, it } from 'bun:test';
import {
	shouldStartProtectedVoiceEventSubscriptions,
	shouldSyncExistingProducersAfterVoiceEventSubscriptionStart,
} from '../hooks/voice-event-sync-policy';

describe('voice event producer sync policy', () => {
	it('syncs existing producers when reconnect recovery is not active', () => {
		expect(shouldSyncExistingProducersAfterVoiceEventSubscriptionStart(undefined)).toBe(true);
	});

	it('skips the eager producer sync while reconnect recovery is active', () => {
		expect(shouldSyncExistingProducersAfterVoiceEventSubscriptionStart(Date.now())).toBe(false);
	});

	it('starts protected subscriptions during steady state', () => {
		expect(shouldStartProtectedVoiceEventSubscriptions(undefined, false)).toBe(true);
	});

	it('defers protected subscriptions while reconnecting without authentication', () => {
		expect(shouldStartProtectedVoiceEventSubscriptions(Date.now(), false)).toBe(false);
	});

	it('starts protected subscriptions after the reconnected socket authenticates', () => {
		expect(shouldStartProtectedVoiceEventSubscriptions(Date.now(), true)).toBe(true);
	});
});
