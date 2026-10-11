import assert from 'node:assert/strict';
import * as Sentry from '@sentry/bun';
import { createOpenTelemetryAdapter } from '@sharkord/shared/telemetry/opentelemetry';
import { createTracing } from '@sharkord/shared/telemetry/tracing';
import { configureServerTracing, startSpanObservation } from '../../tracing';

const captured: Sentry.Event[] = [];
Sentry.init({
	dsn: 'https://public@example.invalid/1',
	tracesSampleRate: 1,
	defaultIntegrations: false,
	transport: () => ({ send: async () => ({}), flush: async () => true }),
	beforeSendTransaction: (event) => {
		captured.push(event);
		return event;
	},
});
configureServerTracing(true);
const tracing = createTracing(createOpenTelemetryAdapter('ripcord.tracing-test'));
const parent = startSpanObservation({ name: 'rpc.voice.restore', op: 'rpc.server' });
await parent.run(async () => {
	await Promise.all(
		['first', 'second'].map((name) =>
			tracing.traceSpan({ name }, async () => {
				const activeId = Sentry.getActiveSpan()?.spanContext().spanId;
				assert.ok(activeId);
				await new Promise((resolve) => setTimeout(resolve, 5));
				assert.equal(Sentry.getActiveSpan()?.spanContext().spanId, activeId);
			}),
		),
	);
});
parent.finish({ status: 'ok' });
parent.finish({ status: 'error' });
configureServerTracing(false);
startSpanObservation({ name: 'disabled' }).finish({ status: 'ok' });
await Sentry.flush(2000);
assert.equal(captured.length, 1);
const transaction = captured[0];
assert.ok(transaction);
assert.equal(transaction.transaction, 'rpc.voice.restore');
assert.equal(transaction.spans?.length, 2);
const parentId = transaction.contexts?.trace?.span_id;
assert.ok(parentId);
for (const span of transaction.spans ?? []) assert.equal(span.parent_span_id, parentId);
assert.equal(new Set(transaction.spans?.map((span) => span.span_id)).size, 2);
console.log('OTel bridge, parent context, concurrent async isolation, disabled tracing: passed');
await Sentry.close(2000);
