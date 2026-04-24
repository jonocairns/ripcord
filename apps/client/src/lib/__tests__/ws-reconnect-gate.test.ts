import { describe, expect, it } from 'bun:test';
import { getWsReconnectOpenAction, shouldResumeDeferredWsReconnect } from '../ws-reconnect-gate';

describe('ws reconnect gate', () => {
	it('ignores socket opens when there is no pending teardown grace', () => {
		expect(
			getWsReconnectOpenAction({
				hasTeardownTimer: false,
				isReconnectOnline: true,
			}),
		).toBe('ignore');
	});

	it('defers socket opens while reconnect is offline-paused', () => {
		expect(
			getWsReconnectOpenAction({
				hasTeardownTimer: true,
				isReconnectOnline: false,
			}),
		).toBe('defer');
	});

	it('resumes immediately when the socket opens while online', () => {
		expect(
			getWsReconnectOpenAction({
				hasTeardownTimer: true,
				isReconnectOnline: true,
			}),
		).toBe('resume');
	});

	it('only resumes a deferred reconnect when the socket is still open', () => {
		expect(
			shouldResumeDeferredWsReconnect({
				hasTeardownTimer: true,
				isSocketOpen: true,
			}),
		).toBe(true);

		expect(
			shouldResumeDeferredWsReconnect({
				hasTeardownTimer: true,
				isSocketOpen: false,
			}),
		).toBe(false);

		expect(
			shouldResumeDeferredWsReconnect({
				hasTeardownTimer: false,
				isSocketOpen: true,
			}),
		).toBe(false);
	});
});
