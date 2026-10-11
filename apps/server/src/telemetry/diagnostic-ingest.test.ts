import { describe, expect, test } from 'bun:test';
import type { TDiagnosticBatch } from '@sharkord/shared';
import { createDiagnosticIngest } from './diagnostic-ingest';

const batch = (now = 100): TDiagnosticBatch => ({
	clientSessionId: crypto.randomUUID(),
	droppedEvents: 0,
	records: [
		{
			id: crypto.randomUUID(),
			occurredAt: now,
			sequence: 1,
			kind: 'exception',
			level: 'error',
			message: 'Bearer secret',
			runtime: 'web',
			release: '2.4.0',
			environment: 'production',
			traceId: 'a'.repeat(32),
			spanId: 'b'.repeat(16),
		},
	],
});
describe('server diagnostic acceptance', () => {
	test('acks before delivery, sanitizes, deduplicates retries and distinguishes reporters', () => {
		const logs: unknown[] = [];
		const errors: unknown[] = [];
		const ingest = createDiagnosticIngest({
			now: () => 100,
			log: (r) => {
				logs.push(r);
			},
			forward: (r, id, session) => {
				errors.push({ r, id, session });
			},
		});
		const input = batch();
		ingest.accept(input, 1);
		ingest.accept(input, 1);
		expect(logs).toHaveLength(0);
		ingest.flush();
		expect(logs).toHaveLength(1);
		expect(JSON.stringify(logs)).not.toContain('secret');
		expect(logs[0]).toMatchObject({
			reporterUserId: 1,
			record: { occurredAt: 100, release: '2.4.0', traceId: 'a'.repeat(32) },
		});
		ingest.accept(input, 2);
		ingest.flush();
		expect(errors).toHaveLength(2);
	});
	test('bounds pending memory, rejects expired/future records and contains both sink failures', () => {
		let calls = 0;
		const ingest = createDiagnosticIngest({
			now: () => 400_000,
			log: () => {
				calls++;
				throw new Error('log');
			},
			forward: () => {
				throw new Error('provider');
			},
		});
		ingest.accept(batch(0), 1);
		ingest.accept(batch(500_000), 1);
		ingest.flush();
		expect(calls).toBe(0);
		for (let i = 0; i < 300; i++) ingest.accept(batch(400_000), 1);
		expect(() => ingest.flush()).not.toThrow();
		expect(calls).toBe(256);
	});
	test('expires stalled server work without calling external providers', () => {
		let now = 100;
		let calls = 0;
		const ingest = createDiagnosticIngest({
			now: () => now,
			log: () => {
				calls++;
			},
			forward: () => {
				calls++;
			},
		});
		ingest.accept(batch(), 1);
		now = 30_101;
		ingest.flush();
		expect(calls).toBe(0);
	});
});

test('dedupe saturation keeps accepting other users and bounds retained retry evidence', () => {
	let deliveries = 0;
	const ingest = createDiagnosticIngest({
		now: () => 100,
		log: () => {
			deliveries++;
		},
		forward: () => {},
	});
	const oldest = batch();
	ingest.accept(oldest, 1);
	ingest.flush();
	for (let i = 1; i < 4096; i++) {
		ingest.accept(batch(), 1);
		ingest.flush();
	}
	const otherUser = batch();
	ingest.accept(otherUser, 2);
	ingest.flush();
	expect(deliveries).toBe(4097);
	ingest.accept(otherUser, 2);
	ingest.flush();
	expect(deliveries).toBe(4097);
	// Capacity pressure evicted the oldest retry key, instead of growing memory.
	ingest.accept(oldest, 1);
	ingest.flush();
	expect(deliveries).toBe(4098);
});

test('counts known loss boundaries without counting acknowledgement retries as new loss', () => {
	let now = 400_000;
	const counts: string[] = [];
	const ingest = createDiagnosticIngest({
		now: () => now,
		health: {
			count: (reason) => {
				counts.push(reason);
			},
		},
		log: () => {
			throw new Error('sink');
		},
		forward: () => {
			throw new Error('provider');
		},
	});
	ingest.accept(batch(0), 1);
	ingest.accept(batch(500_000), 1);
	const accepted = batch(now);
	ingest.accept(accepted, 1);
	ingest.accept(accepted, 1);
	ingest.flush();
	expect(counts).toEqual(['diagnostic_stale', 'diagnostic_future', 'diagnostic_log_failure', 'error_adapter_failure']);
	for (let i = 0; i < 257; i++) ingest.accept(batch(now), 1);
	now += 30_001;
	ingest.flush();
	expect(counts.filter((reason) => reason === 'diagnostic_queue_full')).toHaveLength(1);
	expect(counts.filter((reason) => reason === 'diagnostic_queue_expired')).toHaveLength(256);
});
