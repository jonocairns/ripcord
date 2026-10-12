import { expect, test } from 'bun:test';
import { createTelemetryHealth } from './health';

test('coalesces fixed counters, saturates memory and cancels the final shutdown timer', () => {
	let now = 100;
	const summaries: unknown[] = [];
	const scheduled: (() => void)[] = [];
	let cancelled = 0;
	const health = createTelemetryHealth({
		now: () => now,
		report: (summary) => {
			summaries.push(summary);
		},
		schedule: (flush) => {
			scheduled.push(flush);
			return () => {
				cancelled++;
			};
		},
	});
	for (let i = 0; i < 100; i++) health.count('diagnostic_queue_full');
	health.count('error_export_failure', Number.MAX_SAFE_INTEGER);
	health.count('error_export_failure', Number.MAX_SAFE_INTEGER);
	expect(scheduled).toHaveLength(1);
	expect(summaries).toHaveLength(0);
	now = 60_100;
	scheduled[0]?.();
	expect(summaries).toEqual([
		{
			message: 'Telemetry delivery health',
			source: 'telemetry_health',
			kind: 'telemetry_health',
			windowStartedAt: 100,
			observedAt: 60_100,
			counters: { diagnostic_queue_full: 100, error_export_failure: 0xffff_ffff },
		},
	]);
	health.count('diagnostic_stale');
	health.close();
	health.count('error_export_failure');
	expect(cancelled).toBe(2);
	expect(scheduled).toHaveLength(2);
	expect(summaries).toHaveLength(2);
});

test('failing sinks and scheduling are contained without retry loops or recursion', () => {
	let reports = 0;
	const health = createTelemetryHealth({
		report: () => {
			reports++;
			throw new Error('local logging unavailable');
		},
		schedule: () => {
			throw new Error('timer unavailable');
		},
	});
	expect(() => health.count('diagnostic_log_failure')).not.toThrow();
	expect(() => health.close()).not.toThrow();
	expect(() => health.close()).not.toThrow();
	expect(reports).toBe(1);
});
