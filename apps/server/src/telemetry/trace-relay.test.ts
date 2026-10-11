import { expect, test } from 'bun:test';
import type { TClientTraceBatch } from '@sharkord/shared';
import { createTraceRelay } from './trace-relay';

const batch = (time = 100): TClientTraceBatch => ({
	resourceSpans: [
		{
			resource: { attributes: [], droppedAttributesCount: 0 },
			scopeSpans: [
				{
					scope: { name: 'ripcord.client' },
					spans: [
						{
							traceId: crypto.randomUUID().replaceAll('-', ''),
							spanId: crypto.randomUUID().replaceAll('-', '').slice(0, 16),
							parentSpanId: 'a'.repeat(16),
							name: 'voice.restore',
							kind: 1,
							startTimeUnixNano: String(BigInt(time) * 1000000n),
							endTimeUnixNano: String(BigInt(time + 1) * 1000000n),
							attributes: [{ key: 'password', value: { stringValue: 'secret' } }],
							droppedAttributesCount: 0,
							events: [],
							droppedEventsCount: 0,
							links: [],
							droppedLinksCount: 0,
							status: { code: 1 },
							flags: 257,
						},
					],
				},
			],
		},
	],
});
const destination = { url: 'https://backend/v1/traces', headers: { Authorization: 'server-only' } };
test('relay acknowledges asynchronously, deduplicates per actor and forwards original graph with client resource', async () => {
	const bodies: unknown[] = [];
	const relay = createTraceRelay({
		destination,
		now: () => 100,
		fetch: async (_url, init) => {
			expect(init.headers).toMatchObject({ Authorization: 'server-only', 'Content-Type': 'application/json' });
			bodies.push(JSON.parse(String(init.body)));
			return new Response('{}');
		},
	});
	const input = batch();
	relay.accept(input, 1);
	relay.accept(input, 1);
	relay.accept(input, 2);
	expect(bodies).toHaveLength(0);
	await relay.shutdown();
	expect(bodies).toHaveLength(2);
	expect(JSON.stringify(bodies)).not.toContain('secret');
	expect(bodies[0]).toMatchObject({
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: 'service.name', value: { stringValue: 'ripcord.client' } },
						{ key: 'ripcord.source', value: { stringValue: 'client' } },
						{ key: 'ripcord.reporter_user.id', value: { intValue: '1' } },
					],
				},
				scopeSpans: [
					{
						scope: { name: 'ripcord.client' },
						spans: [
							{
								traceId: input.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.traceId,
								parentSpanId: 'a'.repeat(16),
								flags: 257,
								startTimeUnixNano: '100000000',
							},
						],
					},
				],
			},
		],
	});
});
test('relay bounds memory, expires queued work, rejects stale times and retries provider failure at most three times', async () => {
	let calls = 0;
	let now = 100;
	const relay = createTraceRelay({
		destination,
		now: () => now,
		fetch: async () => {
			calls++;
			return new Response('', { status: 503 });
		},
	});
	for (let i = 0; i < 100; i++) relay.accept(batch(), 1);
	await relay.shutdown();
	expect(calls).toBe(64 * 3);
	const expired = createTraceRelay({
		destination,
		now: () => now,
		fetch: async () => {
			throw Error('must not export');
		},
	});
	expired.accept(batch(), 1);
	now = 30101;
	await expired.shutdown();
	let staleCalls = 0;
	const stale = createTraceRelay({
		destination,
		now: () => 400000,
		fetch: async () => {
			staleCalls++;
			return new Response();
		},
	});
	stale.accept(batch(0), 1);
	stale.accept(batch(500000), 1);
	await stale.shutdown();
	expect(staleCalls).toBe(0);
});
test('shutdown cancels an uncooperative external request within its budget and rejects later work', async () => {
	let calls = 0;
	let signal: AbortSignal | null | undefined;
	const relay = createTraceRelay({
		destination,
		now: () => 100,
		fetch: async (_url, init) => {
			calls++;
			signal = init.signal;
			return new Promise(() => {});
		},
	});
	relay.accept(batch(), 1);
	await relay.shutdown();
	expect(signal?.aborted).toBe(true);
	const atShutdown = calls;
	expect(atShutdown).toBeGreaterThan(0);
	expect(atShutdown).toBeLessThanOrEqual(2);
	relay.accept(batch(), 1);
	await new Promise((r) => setTimeout(r, 1));
	expect(calls).toBe(atShutdown);
}, 5000);

test('dedupe capacity cannot block fresh spans from other users and evicts oldest retry evidence', async () => {
	let calls = 0;
	const relay = createTraceRelay({
		destination,
		now: () => 100,
		fetch: async () => {
			calls++;
			return new Response('{}');
		},
	});
	const oldest = batch();
	relay.accept(oldest, 1);
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (let i = 1; i < 4096; i++) {
		relay.accept(batch(), 1);
		// Drain below queue capacity without expiring deduplication evidence.
		if (i % 32 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
	const otherUser = batch();
	relay.accept(otherUser, 2);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(calls).toBe(4097);
	relay.accept(otherUser, 2);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(calls).toBe(4097);
	relay.accept(oldest, 1);
	await relay.shutdown();
	expect(calls).toBe(4098);
});
