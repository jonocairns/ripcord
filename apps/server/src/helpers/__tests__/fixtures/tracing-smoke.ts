import assert from 'node:assert/strict';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createOpenTelemetryAdapter } from '@sharkord/shared/telemetry/opentelemetry';
import { context, propagation, trace } from '@sharkord/shared/telemetry/propagation';
import { createTracing } from '@sharkord/shared/telemetry/tracing';
import { withTraceDeliveryHealth } from '../../../telemetry/trace-delivery-health';
import { configureServerTracing, startSpanObservation } from '../../tracing';

const bodies: unknown[] = [];
let rejectExport = false;
const health: Record<string, number> = {};
const backend = Bun.serve({
	port: 0,
	fetch: async (request) => {
		bodies.push(await request.json());
		if (rejectExport) return new Response('', { status: 400 });
		return new Response('{}');
	},
});
const provider = new NodeTracerProvider({
	resource: resourceFromAttributes({
		'service.name': 'ripcord.server',
		'service.version': 'test',
		'ripcord.runtime': 'bun',
	}),
	sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0) }),
	spanProcessors: [
		new BatchSpanProcessor(
			withTraceDeliveryHealth(new OTLPTraceExporter({ url: `http://localhost:${backend.port}/v1/traces` }), {
				count: (reason, quantity = 1) => {
					health[reason] = (health[reason] ?? 0) + quantity;
				},
			}),
		),
	],
});
provider.register();
configureServerTracing(true);
const tracing = createTracing(createOpenTelemetryAdapter('ripcord.server'));
const remote = propagation.extract(context.active(), { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` });
await context.with(remote, async () => {
	const parent = startSpanObservation({ name: 'rpc.voice.restore', op: 'rpc.server' });
	await parent.run(async () => {
		await Promise.all(
			['first', 'second'].map((name) =>
				tracing.traceSpan({ name }, async () => {
					const id = trace.getActiveSpan()?.spanContext().spanId;
					assert.ok(id);
					await new Promise((resolve) => setTimeout(resolve, 5));
					assert.equal(trace.getActiveSpan()?.spanContext().spanId, id);
				}),
			),
		);
	});
	parent.finish({ status: 'ok' });
	parent.finish({ status: 'error' });
});
tracing.traceSpan({ name: 'unsampled-root' }, () => {});
const unsampled = propagation.extract(context.active(), { traceparent: `00-${'c'.repeat(32)}-${'d'.repeat(16)}-00` });
context.with(unsampled, () => tracing.traceSpan({ name: 'unsampled-child' }, () => {}));
configureServerTracing(false);
startSpanObservation({ name: 'disabled' }).finish({ status: 'ok' });
await provider.forceFlush();
const spans: { name: string; traceId: string; spanId: string; parentSpanId?: string; flags: number }[] = [];
for (const body of bodies) {
	assert.ok(body && typeof body === 'object' && 'resourceSpans' in body && Array.isArray(body.resourceSpans));
	for (const resource of body.resourceSpans) {
		assert.ok(
			resource.resource.attributes.some(
				(a: { key: string; value: { stringValue?: string } }) =>
					a.key === 'service.name' && a.value.stringValue === 'ripcord.server',
			),
		);
		for (const scope of resource.scopeSpans) spans.push(...scope.spans);
	}
}
assert.equal(spans.length, 3);
const parent = spans.find((s) => s.name === 'rpc.voice.restore');
assert.ok(parent);
assert.equal(parent.traceId, 'a'.repeat(32));
assert.equal(parent.parentSpanId, 'b'.repeat(16));
assert.ok(parent.flags & 1);
for (const span of spans.filter((s) => s !== parent)) {
	assert.equal(span.traceId, parent.traceId);
	assert.equal(span.parentSpanId, parent.spanId);
}
assert.equal(new Set(spans.map((s) => s.spanId)).size, 3);
assert.deepEqual(health, {});
rejectExport = true;
context.with(remote, () => tracing.traceSpan({ name: 'failed-export' }, () => {}));
await assert.rejects(provider.forceFlush());
assert.equal(health.trace_export_failure, 1);
assert.equal(health.trace_export_failed_spans, 1);
await provider.shutdown();
backend.stop(true);
console.log('OTel bridge, parent context, concurrent async isolation, disabled tracing: passed');
