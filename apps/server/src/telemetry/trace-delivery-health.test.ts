import { expect, test } from 'bun:test';
import { ExportResultCode } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { withTraceDeliveryHealth } from './trace-delivery-health';

const finishedSpans = async () => {
	const memory = new InMemorySpanExporter();
	const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
	const tracer = provider.getTracer('test');
	tracer.startSpan('first').end();
	tracer.startSpan('second').end();
	await provider.forceFlush();
	const spans = memory.getFinishedSpans();
	await provider.shutdown();
	return spans;
};

test('exporter observation preserves real span objects, callback result and optional forceFlush receiver', async () => {
	const spans = await finishedSpans();
	expect(spans).toHaveLength(2);
	let callbacks = 0;
	let forceFlushes = 0;
	const counters: Record<string, number> = {};
	const failure = { code: ExportResultCode.FAILED, error: new Error('backend') };
	const exporter: SpanExporter = {
		export: (received, callback) => {
			expect(received).toBe(spans);
			callback(failure);
		},
		shutdown: async () => {},
		forceFlush: async function () {
			expect(this).toBe(exporter);
			forceFlushes++;
		},
	};
	const wrapper = withTraceDeliveryHealth(exporter, {
		count: (reason, quantity = 1) => {
			counters[reason] = (counters[reason] ?? 0) + quantity;
		},
	});
	wrapper.export(spans, (result) => {
		callbacks++;
		expect(result).toBe(failure);
	});
	await wrapper.forceFlush?.();
	await wrapper.shutdown();
	expect(callbacks).toBe(1);
	expect(forceFlushes).toBe(1);
	expect(counters).toEqual({ trace_export_failure: 1, trace_export_failed_spans: 2 });
});

test('throwing health cannot prevent callbacks or turn successful exports into failure', async () => {
	const spans = await finishedSpans();
	const success = { code: ExportResultCode.SUCCESS };
	let result = success;
	let callbacks = 0;
	const wrapper = withTraceDeliveryHealth(
		{ export: (_spans, callback) => callback(result), shutdown: async () => {} },
		{
			count: () => {
				throw new Error('health sink');
			},
		},
	);
	wrapper.export(spans, (received) => {
		expect(received).toBe(success);
		callbacks++;
	});
	result = { code: ExportResultCode.FAILED };
	wrapper.export(spans, (received) => {
		expect(received).toBe(result);
		callbacks++;
	});
	expect(callbacks).toBe(2);
	expect(wrapper.forceFlush).toBeUndefined();
});

test('synchronous export and shutdown rejections retain the original error and count only the failed boundary', async () => {
	const spans = await finishedSpans();
	const error = new Error('original exporter');
	const counters: Record<string, number> = {};
	const wrapper = withTraceDeliveryHealth(
		{
			export: () => {
				throw error;
			},
			shutdown: async () => {
				throw error;
			},
		},
		{
			count: (reason, quantity = 1) => {
				counters[reason] = (counters[reason] ?? 0) + quantity;
			},
		},
	);
	expect(() =>
		wrapper.export(spans, () => {
			throw new Error('must not callback');
		}),
	).toThrow(error);
	await expect(wrapper.shutdown()).rejects.toBe(error);
	expect(counters).toEqual({ trace_export_failure: 1, trace_export_failed_spans: 2, trace_shutdown_failure: 1 });
	const callbackError = new Error('original callback');
	const successful = withTraceDeliveryHealth(
		{ export: (_spans, callback) => callback({ code: ExportResultCode.SUCCESS }), shutdown: async () => {} },
		{
			count: (reason) => {
				counters[reason] = (counters[reason] ?? 0) + 1;
			},
		},
	);
	expect(() =>
		successful.export(spans, () => {
			throw callbackError;
		}),
	).toThrow(callbackError);
	expect(counters.trace_export_failure).toBe(1);
});
