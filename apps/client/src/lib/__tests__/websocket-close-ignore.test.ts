import { describe, expect, it } from 'bun:test';
import { markSocketCloseEventIgnored, shouldIgnoreSocketCloseEvent } from '../websocket-close-ignore';

describe('shouldIgnoreSocketCloseEvent', () => {
	it('only ignores the close event for the socket that was marked', () => {
		const socketA = new EventTarget();
		const socketB = new EventTarget();

		markSocketCloseEventIgnored(socketA);

		expect(
			shouldIgnoreSocketCloseEvent({
				currentTarget: socketB,
				target: socketB,
			}),
		).toBe(false);

		expect(
			shouldIgnoreSocketCloseEvent({
				currentTarget: socketA,
				target: socketA,
			}),
		).toBe(true);

		expect(
			shouldIgnoreSocketCloseEvent({
				currentTarget: socketA,
				target: socketA,
			}),
		).toBe(false);
	});

	it('falls back to the event target when currentTarget is unavailable', () => {
		const socket = new EventTarget();

		markSocketCloseEventIgnored(socket);

		expect(
			shouldIgnoreSocketCloseEvent({
				currentTarget: null,
				target: socket,
			}),
		).toBe(true);
	});
});
