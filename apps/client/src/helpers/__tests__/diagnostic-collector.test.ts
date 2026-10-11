import { describe, expect, test } from 'bun:test';
import type { TDiagnosticBatch, TDiagnosticRecord } from '@sharkord/shared';
import { createDiagnosticCollector } from '../error-reporting/collector';

const record = (occurredAt = 100): Omit<TDiagnosticRecord, 'sequence'> => ({
	id: crypto.randomUUID(),
	occurredAt,
	kind: 'exception',
	level: 'error',
	message: 'failed',
	runtime: 'web',
	release: '2.4.0',
	environment: 'test',
});
const settle = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};
const fixture = (upload?: (batch: TDiagnosticBatch, signal: AbortSignal) => Promise<void>) => {
	const jobs = new Map<ReturnType<typeof setTimeout>, () => void>();
	const batches: TDiagnosticBatch[] = [];
	let now = 100;
	const options = {
		createId: () => crypto.randomUUID(),
		now: () => now,
		upload:
			upload ??
			(async (batch: TDiagnosticBatch) => {
				batches.push(batch);
			}),
		schedule: (cb: () => void, _delay: number) => {
			const timer = setTimeout(() => {}, 60_000);
			timer.unref();
			jobs.set(timer, cb);
			return timer;
		},
		cancel: (timer: ReturnType<typeof setTimeout>) => {
			clearTimeout(timer);
			jobs.delete(timer);
		},
	};
	const collector = createDiagnosticCollector(options);
	return {
		collector,
		batches,
		jobs,
		time: (value: number) => {
			now = value;
		},
		run: async () => {
			const job = jobs.entries().next().value;
			if (!job) throw new Error('Missing job');
			options.cancel(job[0]);
			job[1]();
			await settle();
		},
	};
};
describe('diagnostic delivery boundaries', () => {
	test('drops startup, unsupported and disconnected errors, bounds memory and preserves client time', async () => {
		const f = fixture();
		f.collector.record(record());
		f.collector.configure('a', false);
		f.collector.authenticate();
		f.collector.record(record());
		expect(f.jobs.size).toBe(0);
		f.collector.configure('a', true);
		f.collector.record(record());
		expect(f.jobs.size).toBe(0);
		f.collector.authenticate();
		for (let i = 0; i < 100; i++) f.collector.record(record());
		await f.run();
		expect(f.batches[0]?.records.length).toBe(8);
		expect(f.batches[0]?.droppedEvents).toBe(36);
		expect(f.batches[0]?.records[0]?.occurredAt).toBe(100);
		f.collector.pause();
		f.collector.record(record());
		expect(f.jobs.size).toBe(0);
		f.collector.dispose();
	});
	test('cancels stale uploads and does not let their completion remove a new identity batch', async () => {
		let complete: (() => void) | undefined;
		let signal: AbortSignal | undefined;
		const batches: TDiagnosticBatch[] = [];
		const f = fixture(async (batch, s) => {
			batches.push(batch);
			signal = s;
			if (batches.length === 1)
				await new Promise<void>((resolve) => {
					complete = resolve;
				});
		});
		f.collector.configure('a', true);
		f.collector.authenticate();
		f.collector.record(record());
		await f.run();
		f.collector.configure('b', true);
		expect(signal?.aborted).toBe(true);
		f.collector.authenticate();
		f.collector.record(record());
		complete?.();
		await settle();
		await f.run();
		expect(batches).toHaveLength(2);
		expect(batches[1]?.records).toHaveLength(1);
		expect(batches[1]?.clientSessionId).not.toBe(batches[0]?.clientSessionId);
		f.collector.dispose();
	});
	test('expires offline buffers and exhausts three timed-out uploads, then allows fresh reports', async () => {
		let attempts = 0;
		const f = fixture(async () => {
			attempts++;
			await new Promise<void>(() => {});
		});
		f.collector.configure('a', true);
		f.collector.authenticate();
		f.collector.record(record());
		for (let i = 0; i < 3; i++) {
			await f.run();
			await f.run();
		}
		expect(attempts).toBe(3);
		expect(f.jobs.size).toBe(0);
		f.collector.record(record());
		f.collector.pause();
		f.time(300_101);
		f.collector.authenticate();
		await f.run();
		expect(attempts).toBe(3);
		f.collector.dispose();
	});
	test('flushes a final batch and contains synchronous uploader failures', async () => {
		const f = fixture();
		f.collector.configure('a', true);
		f.collector.authenticate();
		f.collector.record(record());
		await f.collector.flush();
		expect(f.batches).toHaveLength(1);
		f.collector.dispose();
		const broken = fixture(() => {
			throw new Error('export failed');
		});
		broken.collector.configure('a', true);
		broken.collector.authenticate();
		broken.collector.record(record());
		await expect(broken.collector.flush()).resolves.toBeUndefined();
		broken.collector.dispose();
	});
});
