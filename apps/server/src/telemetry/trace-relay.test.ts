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

test('an OTLP outage cannot delay local traces or expire their independent queue', async () => {
	let now = 100;
	let complete: ((response: Response) => void) | undefined;
	const logged: TClientTraceBatch[] = [];
	const counters: Record<string, number> = {};
	const relay = createTraceRelay({
		destination,
		now: () => now,
		log: (input) => logged.push(input),
		fetch: async () =>
			new Promise((resolve) => {
				complete = resolve;
			}),
		health: {
			count: (reason, quantity = 1) => {
				counters[reason] = (counters[reason] ?? 0) + quantity;
			},
		},
	});
	try {
		relay.accept(batch(), 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = batch();
		relay.accept(second, 2);
		relay.accept(second, 2);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(logged).toHaveLength(2);
		now += 30_001;
		complete?.(new Response());
		await relay.shutdown();
		expect(logged).toHaveLength(2);
		expect(counters.trace_relay_queue_expired).toBe(1);
	} finally {
		complete?.(new Response());
		await relay.shutdown();
	}
});

test('OTLP saturation does not reject local output or deduplicate a refused OTLP retry', async () => {
	let complete: ((response: Response) => void) | undefined;
	let calls = 0;
	let logs = 0;
	const relay = createTraceRelay({
		destination,
		now: () => 100,
		log: () => {
			logs++;
		},
		fetch: async () => {
			calls++;
			if (calls === 1)
				return new Promise((resolve) => {
					complete = resolve;
				});
			return new Response();
		},
	});
	try {
		relay.accept(batch(), 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (let i = 0; i < 64; i++) {
			relay.accept(batch(), 1);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const refused = batch();
		relay.accept(refused, 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(logs).toBe(66);
		expect(calls).toBe(1);
		complete?.(new Response());
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toBe(65);
		relay.accept(refused, 1);
		await relay.shutdown();
		expect(calls).toBe(66);
		expect(logs).toBe(66);
	} finally {
		complete?.(new Response());
		await relay.shutdown();
	}
});

test('console-only relay logs sanitized original client spans once without any network destination', async () => {
	const logged: TClientTraceBatch[] = [];
	let requests = 0;
	const relay = createTraceRelay({
		now: () => 100,
		log: (b) => logged.push(b),
		fetch: async () => {
			requests++;
			return new Response('{}');
		},
	});
	const input = batch();
	relay.accept(input, 7);
	relay.accept(input, 7);
	expect(logged).toHaveLength(0);
	await relay.shutdown();
	expect(requests).toBe(0);
	expect(logged).toHaveLength(1);
	expect(JSON.stringify(logged)).not.toContain('secret');
	expect(logged[0]?.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.spanId).toBe(
		input.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.spanId,
	);
});

test('OTLP retries do not duplicate local trace logs and local failures cannot stop forwarding', async () => {
	let logs = 0;
	let requests = 0;
	const health: Record<string, number> = {};
	const relay = createTraceRelay({
		destination,
		now: () => 100,
		log: () => {
			logs++;
			throw new Error('sink failed');
		},
		fetch: async () => {
			requests++;
			return new Response('', { status: requests < 3 ? 503 : 200 });
		},
		health: {
			count: (reason, n = 1) => {
				health[reason] = (health[reason] ?? 0) + n;
			},
		},
	});
	relay.accept(batch(), 7);
	await relay.shutdown();
	expect(logs).toBe(1);
	expect(requests).toBe(3);
	expect(health.trace_log_failure).toBe(1);
	expect(health.trace_relay_failed_batch).toBeUndefined();
});
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
	const counters: Record<string, number> = {};
	let signal: AbortSignal | null | undefined;
	const relay = createTraceRelay({
		destination,
		health: {
			count: (reason, quantity = 1) => {
				counters[reason] = (counters[reason] ?? 0) + quantity;
			},
		},
		now: () => 100,
		fetch: async (_url, init) => {
			calls++;
			signal = init.signal;
			return new Promise(() => {});
		},
	});
	relay.accept(batch(), 1);
	relay.accept(batch(), 1);
	await relay.shutdown();
	expect(counters.trace_relay_shutdown_drop).toBe(2);
	await relay.shutdown();
	expect(counters.trace_relay_shutdown_drop).toBe(2);
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

test('health distinguishes failed attempts, actual retries, permanent losses and eventual success', async () => {
	const counters: Record<string, number> = {};
	let attempts = 0;
	const relay = createTraceRelay({
		destination,
		now: () => 100,
		health: {
			count: (reason, quantity = 1) => {
				counters[reason] = (counters[reason] ?? 0) + quantity;
			},
		},
		fetch: async () => {
			attempts++;
			return new Response('', { status: attempts === 1 ? 503 : 200 });
		},
	});
	relay.accept(batch(), 1);
	await relay.shutdown();
	expect(counters).toEqual({ trace_relay_export_failure: 1, trace_relay_retry: 1 });
	const permanent = createTraceRelay({
		destination,
		now: () => 100,
		health: {
			count: (reason, quantity = 1) => {
				counters[reason] = (counters[reason] ?? 0) + quantity;
			},
		},
		fetch: async () => new Response('', { status: 400 }),
	});
	permanent.accept(batch(), 1);
	await permanent.shutdown();
	expect(counters).toEqual({ trace_relay_export_failure: 2, trace_relay_retry: 1, trace_relay_failed_batch: 1 });
	const exhausted = createTraceRelay({
		destination,
		now: () => 100,
		health: {
			count: (reason, quantity = 1) => {
				counters[reason] = (counters[reason] ?? 0) + quantity;
			},
		},
		fetch: async () => new Response('', { status: 503 }),
	});
	exhausted.accept(batch(), 1);
	await exhausted.shutdown();
	expect(counters).toEqual({ trace_relay_export_failure: 5, trace_relay_retry: 3, trace_relay_failed_batch: 2 });
});

test('capacity accounting excludes duplicates and rejected fresh spans remain eligible on retry', async () => {
	const counts: string[] = [];
	let calls = 0;
	const relay = createTraceRelay({
		destination,
		now: () => 100,
		health: {
			count: (reason) => {
				counts.push(reason);
			},
		},
		fetch: async () => {
			calls++;
			return new Response();
		},
	});
	const accepted = batch();
	relay.accept(accepted, 1);
	for (let i = 1; i < 64; i++) relay.accept(batch(), 1);
	relay.accept(accepted, 1);
	expect(counts).toEqual([]);
	const rejected = batch();
	relay.accept(rejected, 1);
	expect(counts).toEqual(['trace_relay_queue_full']);
	await new Promise((resolve) => setTimeout(resolve, 0));
	relay.accept(rejected, 1);
	await relay.shutdown();
	expect(calls).toBe(65);
	expect(counts).toEqual(['trace_relay_queue_full']);
});

test('health records age/queue expiry and bounds exhausted retries despite failing observers', async () => {
	let now = 400_000;
	const counters: Record<string, number> = {};
	const relay = createTraceRelay({
		destination,
		now: () => now,
		health: {
			count: (reason, quantity = 1) => {
				counters[reason] = (counters[reason] ?? 0) + quantity;
			},
		},
		fetch: async () => {
			throw new Error('must not export expired work');
		},
	});
	relay.accept(batch(0), 1);
	relay.accept(batch(500_000), 1);
	relay.accept(batch(now), 1);
	now += 30_001;
	await relay.shutdown();
	expect(counters).toEqual({ trace_relay_stale: 1, trace_relay_future: 1, trace_relay_queue_expired: 1 });
	let calls = 0;
	const isolated = createTraceRelay({
		destination,
		now: () => 100,
		health: {
			count: () => {
				throw new Error('health');
			},
		},
		fetch: async () => {
			calls++;
			throw new Error('network');
		},
	});
	isolated.accept(batch(), 1);
	await isolated.shutdown();
	expect(calls).toBe(3);
});

test('a retained retry key does not become a new stale-span loss as client time ages', async () => {
	let now = 300_000;
	const counts: string[] = [];
	let exports = 0;
	const relay = createTraceRelay({
		destination,
		now: () => now,
		health: {
			count: (reason) => {
				counts.push(reason);
			},
		},
		fetch: async () => {
			exports++;
			return new Response();
		},
	});
	const input = batch(100);
	relay.accept(input, 1);
	await new Promise((resolve) => setTimeout(resolve, 0));
	now = 400_000;
	relay.accept(input, 1);
	await relay.shutdown();
	expect(counts).toEqual([]);
	expect(exports).toBe(1);
});
