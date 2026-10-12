import { expect, test } from 'bun:test';
import { restoreIds } from '../websocket-outage';

test('recovery fault instrumentation correlates plain and tracing-enabled restore RPCs', () => {
	const plain = { params: { path: 'voice.restoreOrJoin', input: { reconnectAttemptId: 'plain-id' } } };
	const traced = {
		params: {
			path: 'voice.restoreOrJoin',
			input: {
				__ripcordTrace: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
				input: { reconnectAttemptId: 'traced-id' },
			},
		},
	};
	expect(restoreIds(JSON.stringify([plain, traced]))).toEqual(['plain-id', 'traced-id']);
	expect(
		restoreIds(JSON.stringify({ params: { path: 'others.handshake', input: { reconnectAttemptId: 'unrelated' } } })),
	).toEqual([]);
	expect(restoreIds('invalid')).toEqual([]);
});
