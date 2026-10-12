import { expect, test } from 'bun:test';
import { createReplayOnlyTransport } from '../error-reporting/provider-transport';

type TTransport = ReturnType<typeof createReplayOnlyTransport>;
type TEnvelope = Parameters<TTransport['send']>[0];

const replayEnvelope: TEnvelope = [
	{},
	[
		[
			{ type: 'replay_event' },
			{ urls: [], error_ids: [], trace_ids: [], replay_id: 'test-replay', segment_id: 0, replay_type: 'buffer' },
		],
		[{ type: 'replay_recording', length: 2 }, '[]'],
	],
];
const errorEnvelope: TEnvelope = [
	{ event_id: 'test-event', sent_at: '2026-10-12T00:00:00Z' },
	[[{ type: 'event' }, { message: 'private error' }]],
];
const reportEnvelope: TEnvelope = [
	{},
	[
		[
			{ type: 'client_report' },
			{ timestamp: 0, discarded_events: [{ reason: 'before_send', category: 'error', quantity: 1 }] },
		],
	],
];
const sessionEnvelope: TEnvelope = [
	{ sent_at: '2026-10-12T00:00:00Z' },
	[
		[
			{ type: 'session' },
			{
				sid: 'test-session',
				init: true,
				started: '2026-10-12T00:00:00Z',
				timestamp: '2026-10-12T00:00:00Z',
				status: 'ok',
				errors: 0,
				attrs: { release: 'test' },
			},
		],
	],
];

test('parser-only transport drops every envelope without a provider', async () => {
	const transport = createReplayOnlyTransport();
	for (const envelope of [errorEnvelope, reportEnvelope, sessionEnvelope, replayEnvelope])
		expect(await transport.send(envelope)).toEqual({});
	expect(await transport.flush(100)).toBe(true);
});

test('configured replay preserves its envelope and flush result while refusing other provider signals', async () => {
	const sent: TEnvelope[] = [];
	let flushTimeout: number | undefined;
	const transport = createReplayOnlyTransport({
		send: async (envelope) => {
			sent.push(envelope);
			return { statusCode: 202 };
		},
		flush: async (timeout) => {
			flushTimeout = timeout;
			return false;
		},
	});
	await transport.send(errorEnvelope);
	await transport.send(reportEnvelope);
	await transport.send(sessionEnvelope);
	expect(sent).toHaveLength(0);
	expect(await transport.send(replayEnvelope)).toEqual({ statusCode: 202 });
	expect(sent).toEqual([replayEnvelope]);
	expect(sent[0]).toBe(replayEnvelope);
	expect(await transport.flush(250)).toBe(false);
	expect(flushTimeout).toBe(250);
});
