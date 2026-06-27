import { describe, expect, it } from 'bun:test';
import { shouldDeferTransportFailureToReconnect } from '../transport-failure-policy';

describe('shouldDeferTransportFailureToReconnect', () => {
	it('does not defer when no WS reconnect is in progress', () => {
		expect(shouldDeferTransportFailureToReconnect(undefined)).toBe(false);
	});

	it('defers to the reconnect orchestration while a WS reconnect is in progress', () => {
		expect(shouldDeferTransportFailureToReconnect(Date.now())).toBe(true);
	});

	it('defers even when reconnectingSince is 0 (epoch is a valid timestamp)', () => {
		expect(shouldDeferTransportFailureToReconnect(0)).toBe(true);
	});
});
