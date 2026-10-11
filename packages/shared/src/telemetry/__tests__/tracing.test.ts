import { describe, expect, mock, test } from 'bun:test';
import type { Attributes, SpanStatus } from '@opentelemetry/api';
import { createTracing, type TTracingAdapter } from '../tracing';

const createHarness = () => {
	const starts: { name: string; attributes: Attributes }[] = [];
	const attributes: Attributes[] = [];
	const statuses: SpanStatus[] = [];
	const end = mock(() => {});
	const adapter: TTracingAdapter = {
		start: (options) => {
			starts.push(options);
			return {
				run: (effect) => effect(),
				setAttributes: (value) => {
					attributes.push(value);
				},
				setStatus: (status) => {
					statuses.push(status);
				},
				end,
			};
		},
	};
	return { adapter, starts, attributes, statuses, end };
};

describe('portable application tracing', () => {
	test('disabled and failing SDK setup preserve application success and errors', async () => {
		const setup = mock(() => {
			throw new Error('SDK unavailable');
		});
		const disabled = createTracing({ start: setup }, () => false);
		expect(disabled.traceSpan({ name: 'join' }, () => 42)).toBe(42);
		expect(setup).not.toHaveBeenCalled();
		const enabled = createTracing({ start: setup });
		const failure = new Error('media acquisition failed');
		await expect(enabled.traceSpan({ name: 'join' }, () => Promise.reject(failure))).rejects.toBe(failure);
		expect(enabled.traceSpan({ name: 'join' }, () => 42)).toBe(42);
	});

	test('context setup and teardown failures never replay application mutations', async () => {
		for (const before of [true, false]) {
			const harness = createHarness();
			const start = harness.adapter.start;
			harness.adapter.start = (options) => ({
				...start(options),
				run: (effect) => {
					if (!before) effect();
					throw new Error('context manager failed');
				},
			});
			const tracing = createTracing(harness.adapter);
			const effect = mock(() => Promise.resolve('joined'));
			expect(await tracing.traceSpan({ name: 'join' }, effect)).toBe('joined');
			expect(effect).toHaveBeenCalledTimes(1);
			const failure = new Error('original failure');
			const failed = mock(() => {
				throw failure;
			});
			expect(() => tracing.traceSpan({ name: 'join' }, failed)).toThrow(failure);
			expect(failed).toHaveBeenCalledTimes(1);
		}
	});

	test('async completion waits for settlement and preserves rejected values', async () => {
		const harness = createHarness();
		const tracing = createTracing(harness.adapter);
		const { promise, resolve } = Promise.withResolvers<string>();
		const result = tracing.traceSpan({ name: 'restore' }, () => promise);
		expect(harness.end).not.toHaveBeenCalled();
		resolve('restored');
		expect(await result).toBe('restored');
		expect(harness.statuses[0]?.code).toBe(1);
		const failure = { reason: 'original rejection' };
		await expect(tracing.traceSpan({ name: 'restore' }, () => Promise.reject(failure))).rejects.toBe(failure);
		expect(harness.statuses[1]?.code).toBe(2);
		expect(harness.end).toHaveBeenCalledTimes(2);
	});

	test('finishes once and attempts end even if attribute and status exporters fail', () => {
		const end = mock(() => {
			throw new Error('end failed');
		});
		const observation = createTracing({
			start: () => ({
				run: (effect) => effect(),
				setAttributes: () => {
					throw new Error('attributes failed');
				},
				setStatus: () => {
					throw new Error('status failed');
				},
				end,
			}),
		}).startSpanObservation({ name: 'restore' });
		expect(() => observation.finish({ status: 'unset', statusMessage: 'cancelled' })).not.toThrow();
		observation.finish({ status: 'error' });
		expect(end).toHaveBeenCalledTimes(1);
		expect(observation.run(() => 'after finish')).toBe('after finish');
	});

	test('scrubs credentials and bounds attributes before either backend sees them', () => {
		const harness = createHarness();
		const observation = createTracing(harness.adapter).startSpanObservation({
			name: 'voice.restore',
			op: 'voice.session',
			attributes: {
				authorization: 'private',
				'voice.clientToken': 'private',
				description: 'Bearer abc user@example.com https://example.com/?secret=x',
				absent: undefined,
				invalid: Number.NaN,
			},
		});
		expect(harness.starts[0]).toEqual({
			name: 'voice.restore',
			attributes: {
				authorization: '[redacted]',
				'voice.clientToken': '[redacted]',
				description: 'Bearer [redacted] [redacted-email] [redacted-url]',
				'ripcord.operation': 'voice.session',
			},
		});
		observation.finish({ status: 'unset', statusMessage: 'cancelled', attributes: { label: 'x'.repeat(300) } });
		expect(harness.attributes[0]?.label).toHaveLength(200);
		expect(harness.statuses[0]).toEqual({ code: 0, message: 'cancelled' });
	});
	test('preserves the operation when the application fills the attribute budget', () => {
		const harness = createHarness();
		const attributes = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`voice.field_${index}`, index]));
		createTracing(harness.adapter).startSpanObservation({ name: 'voice.restore', op: 'voice.session', attributes });
		const captured = harness.starts[0]?.attributes;
		expect(captured?.['ripcord.operation']).toBe('voice.session');
		expect(captured?.['voice.field_19']).toBe(19);
		expect(captured).not.toHaveProperty('voice.field_20');
		expect(Object.keys(captured ?? {})).toHaveLength(21);
	});
});
