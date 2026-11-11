import { expect, test } from 'bun:test';
import type { TDiagnosticBatch, TDiagnosticRecord } from '@sharkord/shared';
import { createDiagnosticIngest } from './diagnostic-ingest';
import { createSentryErrorAdapter } from './sentry-errors';

const record = (occurredAt: number, sequence = 1): TDiagnosticRecord => ({
	id: crypto.randomUUID(),
	sequence,
	occurredAt,
	kind: 'exception',
	level: 'error',
	message: 'mute diagnostic',
	runtime: 'desktop',
	release: '2.6.0',
	environment: 'production',
	breadcrumbs: [{ occurredAt: occurredAt - 1000, message: 'before' }],
});
const batch = (...records: TDiagnosticRecord[]): TDiagnosticBatch => ({
	clientSessionId: crypto.randomUUID(),
	droppedEvents: 0,
	records,
});

test('batch correction preserves times and ordering, counts batches and exports corrected event and breadcrumbs', async () => {
	const envelopes: unknown[] = [];
	const logs: unknown[] = [];
	const counts: string[] = [];
	const adapter = createSentryErrorAdapter('https://public@sentry.invalid/1', () => ({
		send: async (envelope) => {
			envelopes.push(envelope);
			return { statusCode: 200 };
		},
		flush: async () => true,
	}));
	const ingest = createDiagnosticIngest({
		now: () => 400_000,
		log: (entry) => {
			logs.push(entry);
		},
		forward: adapter.forward,
		health: {
			count: (reason) => {
				counts.push(reason);
			},
		},
	});
	const input = batch(record(1_000_000), record(1_002_000, 2));
	ingest.accept(input, 7);
	ingest.flush();
	await adapter.flush();
	expect(logs).toMatchObject([
		{ record: { occurredAt: 398_000, originalOccurredAt: 1_000_000, clockSkewMs: 602_000, clockSkewCorrected: true } },
		{ record: { occurredAt: 400_000, originalOccurredAt: 1_002_000, clockSkewMs: 602_000, clockSkewCorrected: true } },
	]);
	expect(counts).toEqual(['diagnostic_clock_skew_corrected_batches']);
	expect(JSON.stringify(envelopes)).toContain('"timestamp":398');
	expect(JSON.stringify(envelopes)).toContain('"timestamp":397');
	expect(JSON.stringify(envelopes)).toContain('"timestamp":400');
	expect(JSON.stringify(envelopes)).toContain('"timestamp":399');
	expect(input.records.map((r) => r.occurredAt)).toEqual([1_000_000, 1_002_000]);
	ingest.accept(input, 7);
	ingest.flush();
	expect(logs).toHaveLength(2);
});

test('past cutoff, receipt dedupe expiry and future threshold remain bounded', () => {
	let now = 400_000;
	const logs: unknown[] = [];
	const counts: string[] = [];
	const ingest = createDiagnosticIngest({
		now: () => now,
		log: (entry) => {
			logs.push(entry);
		},
		forward: () => {},
		health: {
			count: (reason) => {
				counts.push(reason);
			},
		},
	});
	ingest.accept(batch(record(99_999)), 1);
	const boundary = batch(record(460_000));
	ingest.accept(boundary, 1);
	ingest.accept(boundary, 1);
	ingest.flush();
	expect(logs).toHaveLength(1);
	expect(logs[0]).toMatchObject({ record: { occurredAt: 460_000 } });
	expect(counts).toEqual(['diagnostic_stale']);
	now += 300_000;
	ingest.accept(boundary, 1);
	ingest.flush();
	expect(logs).toHaveLength(2);
});

test('extreme schema-valid future dates have no skew cap and invalid shifted breadcrumbs are omitted', () => {
	const logs: unknown[] = [];
	const extreme = record(8_640_000_000_000_000);
	extreme.breadcrumbs = [
		{ occurredAt: 0, message: 'too old' },
		{ occurredAt: extreme.occurredAt, message: 'now' },
	];
	const ingest = createDiagnosticIngest({
		now: () => 400_000,
		log: (entry) => {
			logs.push(entry);
		},
		forward: () => {},
	});
	ingest.accept(batch(extreme), 1);
	ingest.flush();
	expect(logs).toMatchObject([
		{
			record: {
				occurredAt: 400_000,
				originalOccurredAt: extreme.occurredAt,
				clockSkewCorrected: true,
				breadcrumbs: [{ occurredAt: 400_000, message: 'now' }],
			},
		},
	]);
});

const collectingIngest = (now: number) => {
	const logs: { record: { occurredAt: number; clockSkewCorrected?: boolean } }[] = [];
	const counts: string[] = [];
	const ingest = createDiagnosticIngest({
		now: () => now,
		log: (entry) => {
			logs.push(entry);
		},
		forward: () => {},
		health: {
			count: (reason) => {
				counts.push(reason);
			},
		},
	});
	return { ingest, logs, counts };
};

test('a mixed batch keeps a correctly stamped record instead of correcting it into the stale window', () => {
	const { ingest, logs, counts } = collectingIngest(400_000);
	// The client clock was fixed between these two records: one is 580 s ahead, one is 5 s old.
	ingest.accept(batch(record(980_000), record(395_000, 2)), 1);
	ingest.flush();
	expect(logs).toMatchObject([
		{ record: { occurredAt: 400_000, clockSkewCorrected: true } },
		{ record: { occurredAt: 395_000 } },
	]);
	expect(logs[1]?.record.clockSkewCorrected).toBeUndefined();
	expect(counts).toEqual(['diagnostic_clock_skew_corrected_batches']);
});

test('the batch offset comes from the latest stamp, not from array position', () => {
	const { ingest, logs } = collectingIngest(400_000);
	ingest.accept(batch(record(1_002_000, 2), record(1_000_000)), 1);
	ingest.flush();
	expect(logs.map((entry) => entry.record.occurredAt)).toEqual([400_000, 398_000]);
});

test('a skewed record that is stale even after correction is still dropped', () => {
	const { ingest, logs, counts } = collectingIngest(400_000);
	// Offset 600 s from the newest record; the older record lands 301 s before receipt.
	ingest.accept(batch(record(1_000_000), record(699_000, 2)), 1);
	ingest.flush();
	expect(logs).toMatchObject([{ record: { occurredAt: 400_000 } }]);
	expect(counts).toEqual(['diagnostic_stale', 'diagnostic_clock_skew_corrected_batches']);
});

test('a replayed or fully dropped skewed batch does not count as corrected again', () => {
	const { ingest, counts } = collectingIngest(400_000);
	const skewed = batch(record(1_000_000));
	ingest.accept(skewed, 1);
	ingest.accept(skewed, 1);
	ingest.flush();
	expect(counts).toEqual(['diagnostic_clock_skew_corrected_batches']);
});
