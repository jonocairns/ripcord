import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { StackContextManager, WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import type { TClientTraceBatch } from '@sharkord/shared';
import { createOpenTelemetryAdapter } from '@sharkord/shared/telemetry/opentelemetry';
import { context, propagation, trace } from '@sharkord/shared/telemetry/propagation';
import { createRpcTraceExporter } from './rpc-exporter';
import { configureClientTracing } from './tracing';

let provider: WebTracerProvider | undefined;
let exporter: ReturnType<typeof createRpcTraceExporter> | undefined;
let identity: string | undefined;
let generation = 0;
let propagationEnabled = false;
export const isTracePropagationEnabled = () => propagationEnabled;
export const stopClientTracing = () => {
	propagationEnabled = false;
	identity = undefined;
	generation++;
	configureClientTracing(undefined);
	exporter?.cancel();
	exporter = undefined;
	const previous = provider;
	provider = undefined;
	if (previous) void previous.shutdown().catch(() => {});
	trace.disable();
	context.disable();
	propagation.disable();
};
export const configureTraceBackend = (options: {
	identity: string;
	enabled: boolean;
	sampleRate: number;
	runtime: string;
	release: string;
	clientSessionId: string;
	upload: (batch: TClientTraceBatch, signal: AbortSignal) => Promise<void>;
}): void => {
	try {
		if (!options.enabled || options.sampleRate <= 0) {
			stopClientTracing();
			return;
		}
		if (identity === options.identity && provider) return;
		stopClientTracing();
		identity = options.identity;
		const current = generation;
		exporter = createRpcTraceExporter(options.upload);
		provider = new WebTracerProvider({
			resource: resourceFromAttributes({
				'service.name': 'ripcord.client',
				'service.version': options.release,
				'ripcord.runtime': options.runtime,
				'ripcord.client_session.id': options.clientSessionId,
			}),
			sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(options.sampleRate) }),
			spanProcessors: [
				new BatchSpanProcessor(exporter, {
					maxQueueSize: 64,
					maxExportBatchSize: 16,
					scheduledDelayMillis: 2000,
					exportTimeoutMillis: 7000,
				}),
			],
			spanLimits: { attributeCountLimit: 24, attributeValueLengthLimit: 200, eventCountLimit: 0, linkCountLimit: 0 },
		});
		provider.register({ contextManager: new StackContextManager(), propagator: new W3CTraceContextPropagator() });
		const delegate = createOpenTelemetryAdapter('ripcord.client');
		configureClientTracing({
			start: (options) => {
				const span = delegate.start(options);
				return { ...span, run: (effect) => (current === generation ? span.run(effect) : effect()) };
			},
		});
		propagationEnabled = true;
	} catch {
		stopClientTracing();
	}
};
export const flushClientTracing = async () => {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			provider?.forceFlush(),
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, 1000);
			}),
		]);
	} catch {
		/* Best effort. */
	} finally {
		clearTimeout(timeout);
	}
};
