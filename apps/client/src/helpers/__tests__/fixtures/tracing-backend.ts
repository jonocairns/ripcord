import assert from 'node:assert/strict';
import type { AppRouter, TClientTraceBatch } from '@sharkord/shared';
import { context, propagation, trace } from '@sharkord/shared/telemetry/propagation';
import { createTRPCProxyClient, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { tracingLink } from '@/lib/tracing-link';
import { configureTraceBackend, flushClientTracing, stopClientTracing } from '../../telemetry/backend';
import { startSpanObservation, traceSpan } from '../../telemetry/tracing';

const sent: TClientTraceBatch[] = [];
const options = {
	identity: 'server:user1',
	enabled: true,
	sampleRate: 1,
	runtime: 'desktop',
	release: 'test',
	clientSessionId: crypto.randomUUID(),
	upload: async (batch: TClientTraceBatch) => {
		sent.push(batch);
	},
};
configureTraceBackend(options);
const parent = startSpanObservation({ name: 'voice.restore' });
const carrier: Record<string, string> = {};
parent.run(() => {
	propagation.inject(context.active(), carrier);
	traceSpan({ name: 'voice.transport', attributes: { producerId: 'producer-1', authorization: 'secret' } }, () => {});
});
let carrierCount = 0;
const terminal: TRPCLink<AppRouter> =
	() =>
	({ op }) =>
		observable((observer) => {
			const input = op.input;
			assert.ok(input && typeof input === 'object' && '__ripcordTrace' in input);
			const carrier = input.__ripcordTrace;
			assert.ok(
				carrier && typeof carrier === 'object' && 'traceparent' in carrier && typeof carrier.traceparent === 'string',
			);
			assert.ok(carrier.traceparent.startsWith(`00-${trace.getActiveSpan()?.spanContext().traceId}-`));
			carrierCount++;
			observer.next({ result: { data: { handshakeHash: 'hash', hasPassword: false } } });
			observer.complete();
		});
const rpc = createTRPCProxyClient<AppRouter>({ links: [tracingLink, terminal] });
await parent.run(() => rpc.others.handshake.query());
assert.equal(carrierCount, 1);
parent.finish({ status: 'ok' });
await flushClientTracing();
const spans = sent.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
assert.equal(spans.length, 3);
const root = spans.find((s) => s.name === 'voice.restore');
const child = spans.find((s) => s.name === 'voice.transport');
assert.ok(root && child);
assert.equal(child.traceId, root.traceId);
assert.equal(child.parentSpanId, root.spanId);
assert.equal(carrier.traceparent, `00-${root.traceId}-${root.spanId}-01`);
assert.ok(root.flags & 1);
assert.ok(!JSON.stringify(sent).includes('secret'));
assert.ok(
	sent[0]?.resourceSpans[0]?.resource.attributes.some(
		(a) => a.key === 'service.name' && 'stringValue' in a.value && a.value.stringValue === 'ripcord.client',
	),
);
// A pending batch is canceled on identity change; stale observations cannot inject old context.
const stale = startSpanObservation({ name: 'stale' });
traceSpan({ name: 'discard-old-queue' }, () => {});
let entered = 0;
configureTraceBackend({
	...options,
	identity: 'server:user2',
	sampleRate: 1,
	upload: async (b) => {
		entered++;
		sent.push(b);
	},
});
stale.run(() => assert.equal(trace.getActiveSpan(), undefined));
stale.finish({ status: 'ok' });
traceSpan({ name: 'new-identity' }, () => {});
await flushClientTracing();
assert.equal(entered, 1);
assert.ok(
	!sent
		.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)))
		.some((s) => s.name === 'discard-old-queue' || s.name === 'stale'),
);
const before = sent.length;
configureTraceBackend({ ...options, identity: 'zero', sampleRate: 0 });
traceSpan({ name: 'disabled' }, () => {});
await flushClientTracing();
assert.equal(sent.length, before);
// SDK bounds the queue during outage; force flush can run four bounded exports concurrently.
let outageCalls = 0;
configureTraceBackend({
	...options,
	identity: 'outage',
	upload: async () => {
		outageCalls++;
		throw Error('offline');
	},
});
for (let i = 0; i < 300; i++) traceSpan({ name: `bounded-${i}` }, () => {});
await flushClientTracing();
assert.ok(outageCalls <= 15);
stopClientTracing();
console.log('client span graph, identity switch, sampling, bounded outage: passed');
