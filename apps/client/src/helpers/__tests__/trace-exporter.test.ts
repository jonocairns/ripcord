import { expect, test } from 'bun:test';
import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createRpcTraceExporter } from '../telemetry/rpc-exporter';

const readable = () => {
	const memory = new InMemorySpanExporter();
	const p = new BasicTracerProvider({
		resource: resourceFromAttributes({ 'service.name': 'ripcord.client' }),
		spanProcessors: [new SimpleSpanProcessor(memory)],
	});
	const span = p.getTracer('ripcord.client').startSpan('voice.restore');
	span.end();
	return memory.getFinishedSpans();
};
test('standard serialization preserves client context, retries bounded failures and reports one result', async () => {
	const spans = readable();
	let calls = 0;
	const exporter = createRpcTraceExporter(async (batch) => {
		calls++;
		const span = batch.resourceSpans[0]?.scopeSpans[0]?.spans[0];
		expect(span?.traceId).toBe(spans[0]?.spanContext().traceId);
		expect(span?.spanId).toBe(spans[0]?.spanContext().spanId);
		throw Error('offline');
	});
	const result = await new Promise<ExportResult>((resolve) => exporter.export(spans, resolve));
	expect(result).toMatchObject({ code: ExportResultCode.FAILED });
	expect(calls).toBe(3);
	await exporter.shutdown();
});
test('identity cancellation releases non-cooperative upload and prevents retries or new sends', async () => {
	let calls = 0;
	let signal: AbortSignal | undefined;
	const exporter = createRpcTraceExporter(async (_batch, s) => {
		calls++;
		signal = s;
		return new Promise(() => {});
	});
	const pending = new Promise<ExportResult>((resolve) => exporter.export(readable(), resolve));
	await new Promise((resolve) => setTimeout(resolve, 0));
	exporter.cancel();
	expect(await pending).toMatchObject({ code: ExportResultCode.FAILED });
	expect(signal?.aborted).toBe(true);
	expect(calls).toBe(1);
	expect(await new Promise<ExportResult>((resolve) => exporter.export(readable(), resolve))).toMatchObject({
		code: ExportResultCode.FAILED,
	});
	expect(calls).toBe(1);
});
