import { expect, test } from 'bun:test';
import { ExportResultCode } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { TClientTraceBatch } from '@sharkord/shared';
import { context, trace } from '@sharkord/shared/telemetry/propagation';
import { createTraceLogExporter, logClientTraceBatch } from './trace-log';

test('local exporter preserves real span graph/timing/status and excludes sensitive metadata', async () => {
	const records: Parameters<Parameters<typeof createTraceLogExporter>[0]>[0][] = [];
	const memory = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		resource: resourceFromAttributes({ 'service.version': 'test', 'private.resource': 'private' }),
		spanProcessors: [new SimpleSpanProcessor(memory)],
	});
	const tracer = provider.getTracer('ripcord.server');
	const parent = tracer.startSpan('voice.restore');
	const child = tracer.startSpan(
		'rpc.voice.join',
		{
			attributes: {
				attempt: 2,
				password: 'secret',
				url: 'https://private.test',
				email: 'user@example.com',
				nested: ['private'],
			},
		},
		trace.setSpan(context.active(), parent),
	);
	child.setStatus({ code: 2, message: 'private status text' });
	child.end();
	parent.end();
	const spans = memory.getFinishedSpans();
	const exporter = createTraceLogExporter((record) => records.push(record));
	await new Promise<void>((resolve) =>
		exporter.export(spans, (result) => {
			expect(result.code).toBe(ExportResultCode.SUCCESS);
			resolve();
		}),
	);
	expect(records[0]).toMatchObject({
		source: 'server',
		kind: 'trace',
		traceId: child.spanContext().traceId,
		spanId: child.spanContext().spanId,
		parentSpanId: parent.spanContext().spanId,
		status: 'error',
		attributes: { attempt: 2, password: '[redacted]', url: '[redacted-url]', email: '[redacted]' },
	});
	expect(records[0]?.durationMs).toBeGreaterThanOrEqual(0);
	expect(JSON.stringify(records)).not.toContain('private');
	expect(records[0]?.attributes.nested).toBeUndefined();
	let calls = 0;
	const failing = createTraceLogExporter(() => {
		calls++;
		throw new Error('sink failed');
	});
	failing.export(spans, (result) => expect(result.code).toBe(ExportResultCode.FAILED));
	expect(calls).toBe(2);
	await provider.shutdown();
});

test('client log records retain authenticated identity and original nanosecond times', () => {
	const logged: unknown[] = [];
	const batch: TClientTraceBatch = {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: 'ripcord.reporter_user.id', value: { intValue: '7' } },
						{ key: 'ripcord.runtime', value: { stringValue: 'desktop' } },
						{ key: 'service.version', value: { stringValue: 'client-release' } },
					],
					droppedAttributesCount: 0,
				},
				scopeSpans: [
					{
						scope: { name: 'ripcord.client' },
						spans: [
							{
								traceId: 'a'.repeat(32),
								spanId: 'b'.repeat(16),
								parentSpanId: 'c'.repeat(16),
								name: 'voice.restore',
								kind: 1,
								startTimeUnixNano: '1000000000',
								endTimeUnixNano: '1005000000',
								attributes: [],
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
	};
	logClientTraceBatch(batch, (record) => logged.push(record));
	expect(logged[0]).toMatchObject({
		source: 'client',
		reporterUserId: 7,
		runtime: 'desktop',
		release: 'client-release',
		traceId: 'a'.repeat(32),
		parentSpanId: 'c'.repeat(16),
		durationMs: 5,
		occurredAt: 1000,
		startTimeUnixNano: '1000000000',
		status: 'ok',
	});
	const spans = batch.resourceSpans[0]?.scopeSpans[0]?.spans;
	const original = spans?.[0];
	if (!spans || !original) throw new Error('Missing test span');
	spans.push({ ...original, spanId: 'd'.repeat(16) });
	let writes = 0;
	expect(() =>
		logClientTraceBatch(batch, () => {
			writes++;
			if (writes === 1) throw new Error('sink failed');
		}),
	).toThrow('Client trace log write failed');
	expect(writes).toBe(2);
});
