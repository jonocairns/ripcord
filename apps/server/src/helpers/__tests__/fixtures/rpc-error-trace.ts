import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { getActiveTraceContext } from '@sharkord/shared/telemetry/opentelemetry';
import { initTRPC } from '@trpc/server';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { WebSocket, WebSocketServer } from 'ws';
import { consumeErrorTraceContext, rememberErrorTraceContext } from '../../error-trace-context';
import { configureServerTracing, startSpanObservation } from '../../tracing';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
configureServerTracing(true);
const t = initTRPC.create();
let handlerContext: ReturnType<typeof getActiveTraceContext> = {};
const original = new Error('fixture handler failed');
const router = t.router({
	fail: t.procedure
		.use(async ({ next }) => {
			const observation = startSpanObservation({ name: 'rpc.fail' });
			const result = await observation.run(async () => {
				const result = await next();
				if (!result.ok) rememberErrorTraceContext(result.error);
				return result;
			});
			observation.finish({ status: result.ok ? 'ok' : 'error' });
			return result;
		})
		.query(async () => {
			await Promise.resolve();
			handlerContext = getActiveTraceContext();
			throw original;
		}),
});
const wss = new WebSocketServer({ port: 0 });
if (!wss.address()) await new Promise<void>((resolve) => wss.once('listening', resolve));
const address = wss.address();
assert.ok(address && typeof address === 'object');
let reports = 0;
applyWSSHandler({
	wss,
	router,
	onError: ({ error }) => {
		reports++;
		assert.equal(error.cause, original);
		assert.deepEqual(getActiveTraceContext(), {});
		const saved = consumeErrorTraceContext(error);
		assert.deepEqual(saved, handlerContext);
		assert.equal(consumeErrorTraceContext(error), undefined);
		const span = exporter.getFinishedSpans().find((span) => span.name === 'rpc.fail');
		assert.ok(span);
		assert.equal(saved?.traceId, span.spanContext().traceId);
		assert.equal(saved?.spanId, span.spanContext().spanId);
	},
});
const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
await new Promise<void>((resolve, reject) => {
	ws.once('open', resolve);
	ws.once('error', reject);
});
const reply = new Promise<void>((resolve) => ws.once('message', () => resolve()));
ws.send(JSON.stringify({ id: 1, method: 'query', params: { path: 'fail' } }));
await reply;
assert.equal(reports, 1);
ws.terminate();
await new Promise<void>((resolve) => wss.close(() => resolve()));
await provider.shutdown();
console.log('RPC error callback retains original exported span context exactly once: passed');
