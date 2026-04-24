import { describe, expect, it } from 'bun:test';
import { shouldSyncExistingProducersAfterVoiceEventSubscriptionStart } from '../hooks/voice-event-sync-policy';

describe('voice event producer sync policy', () => {
	it('syncs existing producers when reconnect recovery is not active', () => {
		expect(shouldSyncExistingProducersAfterVoiceEventSubscriptionStart(undefined)).toBe(true);
	});

	it('skips the eager producer sync while reconnect recovery is active', () => {
		expect(shouldSyncExistingProducersAfterVoiceEventSubscriptionStart(Date.now())).toBe(false);
	});
});
