import { describe, expect, it } from 'bun:test';
import { resolveWsRejoinFailureAction } from '../ws-rejoin-failure-policy';

describe('resolveWsRejoinFailureAction', () => {
	it('cancels work superseded by a newer reconnect generation', () => {
		expect(
			resolveWsRejoinFailureAction({
				generationChanged: true,
				isAuthError: true,
				isSocketOpen: false,
			}),
		).toBe('cancel-stale');
	});

	it('waits for the next reconnect when the socket dropped during rejoin', () => {
		for (const isAuthError of [false, true]) {
			expect(
				resolveWsRejoinFailureAction({
					generationChanged: false,
					isAuthError,
					isSocketOpen: false,
				}),
			).toBe('wait-for-reconnect');
		}
	});

	it('refreshes auth for an auth failure on the active socket', () => {
		expect(
			resolveWsRejoinFailureAction({
				generationChanged: false,
				isAuthError: true,
				isSocketOpen: true,
			}),
		).toBe('refresh-auth');
	});

	it('tears down for a non-auth rejoin failure on the active socket', () => {
		expect(
			resolveWsRejoinFailureAction({
				generationChanged: false,
				isAuthError: false,
				isSocketOpen: true,
			}),
		).toBe('teardown');
	});
});
