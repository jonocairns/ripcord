import { beforeEach, describe, expect, it } from 'bun:test';
import {
	bufferReconnectSnapshotEvent,
	clearReconnectSnapshotEventBuffer,
	flushReconnectSnapshotEventBuffer,
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
});
