import { beforeEach, describe, expect, it } from 'bun:test';
import {
	clearPendingVoiceReconnectChannelId,
	getPendingVoiceReconnectChannelId,
	getPendingVoiceReconnectRetryCount,
	incrementPendingVoiceReconnectRetryCount,
	setPendingVoiceReconnectChannelId,
} from '../reconnect-state';

describe('voice reconnect state', () => {
	beforeEach(() => {
		clearPendingVoiceReconnectChannelId();
	});

	it('tracks retry attempts until the pending reconnect state is cleared', () => {
		setPendingVoiceReconnectChannelId(42);

		expect(getPendingVoiceReconnectChannelId()).toBe(42);
		expect(getPendingVoiceReconnectRetryCount()).toBe(0);
		expect(incrementPendingVoiceReconnectRetryCount()).toBe(1);
		expect(incrementPendingVoiceReconnectRetryCount()).toBe(2);
		expect(getPendingVoiceReconnectRetryCount()).toBe(2);
	});

	it('resets retry attempts when pending reconnect state changes', () => {
		setPendingVoiceReconnectChannelId(42);
		incrementPendingVoiceReconnectRetryCount();

		setPendingVoiceReconnectChannelId(77);

		expect(getPendingVoiceReconnectChannelId()).toBe(77);
		expect(getPendingVoiceReconnectRetryCount()).toBe(0);

		incrementPendingVoiceReconnectRetryCount();
		clearPendingVoiceReconnectChannelId();

		expect(getPendingVoiceReconnectChannelId()).toBeUndefined();
		expect(getPendingVoiceReconnectRetryCount()).toBe(0);
	});
});
