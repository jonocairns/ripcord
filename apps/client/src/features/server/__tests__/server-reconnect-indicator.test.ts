import { describe, expect, test } from 'bun:test';
import { getServerReconnectIndicatorDelayMs, getServerReconnectIndicatorText } from '../server-reconnect-indicator';

describe('server reconnect indicator', () => {
	test('only a recovering session has a delay', () => {
		expect(getServerReconnectIndicatorDelayMs({ name: 'idle' }, 1_000)).toBeUndefined();
		expect(getServerReconnectIndicatorDelayMs({ name: 'connecting' }, 1_000)).toBeUndefined();
		expect(getServerReconnectIndicatorDelayMs({ name: 'ready' }, 1_000)).toBeUndefined();
	});

	test('waits two seconds from the original session loss', () => {
		for (const [now, expected] of [
			[1_000, 2_000],
			[1_500, 1_500],
			[2_999, 1],
			[3_000, 0],
			[5_000, 0],
		]) {
			expect(getServerReconnectIndicatorDelayMs({ name: 'recovering', since: 1_000 }, now)).toBe(expected);
		}
	});

	test('a future loss timestamp cannot delay the indicator beyond two seconds', () => {
		expect(getServerReconnectIndicatorDelayMs({ name: 'recovering', since: 5_000 }, 1_000)).toBe(2_000);
		expect(getServerReconnectIndicatorDelayMs({ name: 'recovering', since: 1_000 }, 1_000)).toBe(2_000);
	});

	test('explains online recovery and waiting for the network exactly', () => {
		expect(getServerReconnectIndicatorText(true)).toEqual({
			title: 'Reconnecting...',
			detail: 'Trying to reach the server.',
		});
		expect(getServerReconnectIndicatorText(false)).toEqual({
			title: "You're offline",
			detail: 'Will reconnect when your network is back.',
		});
	});
});
