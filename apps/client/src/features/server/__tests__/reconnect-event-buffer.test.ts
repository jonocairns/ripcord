import { beforeEach, describe, expect, it } from 'bun:test';
import {
	bufferReconnectSnapshotEvent,
	clearReconnectSnapshotEventBuffer,
	flushReconnectSnapshotEventBuffer,
	pauseReconnectSnapshotEventBuffer,
	startReconnectSnapshotEventBuffer,
} from '../reconnect-event-buffer';

describe('reconnect event buffer', () => {
	beforeEach(() => {
		clearReconnectSnapshotEventBuffer();
	});

	it('buffers actions until the reconnect snapshot flushes', () => {
		const calls: string[] = [];

		startReconnectSnapshotEventBuffer();

		expect(
			bufferReconnectSnapshotEvent(() => {
				calls.push('first');
			}),
		).toBe(true);
		expect(
			bufferReconnectSnapshotEvent(() => {
				calls.push('second');
			}),
		).toBe(true);

		expect(calls).toEqual([]);

		flushReconnectSnapshotEventBuffer();

		expect(calls).toEqual(['first', 'second']);
	});

	it('does not buffer when reconnect snapshot buffering is inactive', () => {
		const calls: string[] = [];

		expect(
			bufferReconnectSnapshotEvent(() => {
				calls.push('ignored');
			}),
		).toBe(false);

		expect(calls).toEqual([]);
	});

	it('drops buffered actions when the reconnect snapshot is cleared', () => {
		const calls: string[] = [];

		startReconnectSnapshotEventBuffer();
		bufferReconnectSnapshotEvent(() => {
			calls.push('stale');
		});

		clearReconnectSnapshotEventBuffer();
		flushReconnectSnapshotEventBuffer();

		expect(calls).toEqual([]);
	});

	it('pause stops buffering but retains events for the next start', () => {
		const calls: string[] = [];

		startReconnectSnapshotEventBuffer();
		bufferReconnectSnapshotEvent(() => {
			calls.push('from-failed-attempt');
		});

		// Simulate a failed reconnect attempt: pause without discarding.
		pauseReconnectSnapshotEventBuffer();

		// Events arriving while paused are NOT buffered.
		expect(
			bufferReconnectSnapshotEvent(() => {
				calls.push('during-pause');
			}),
		).toBe(false);

		// Retry: resume buffering — retained events carry forward.
		startReconnectSnapshotEventBuffer();
		bufferReconnectSnapshotEvent(() => {
			calls.push('from-retry');
		});

		flushReconnectSnapshotEventBuffer();

		expect(calls).toEqual(['from-failed-attempt', 'from-retry']);
	});

	it('clear after pause discards retained events', () => {
		const calls: string[] = [];

		startReconnectSnapshotEventBuffer();
		bufferReconnectSnapshotEvent(() => {
			calls.push('stale');
		});

		pauseReconnectSnapshotEventBuffer();
		clearReconnectSnapshotEventBuffer();

		startReconnectSnapshotEventBuffer();
		flushReconnectSnapshotEventBuffer();

		expect(calls).toEqual([]);
	});
});
