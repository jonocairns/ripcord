import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { config } from '../config';
import { configureServerTracing } from '../helpers/tracing';
import { SERVER_VERSION } from '../utils/env';
import { telemetryHealth } from './health';
import { parseTraceDestination } from './trace-config';
import { withTraceDeliveryHealth } from './trace-delivery-health';
import { createTraceRelay } from './trace-relay';

const destination = parseTraceDestination(config.server.tracingOtlpEndpoint, config.server.tracingOtlpHeaders);
if (!destination && config.server.tracingOtlpEndpoint.trim()) telemetryHealth.count('trace_configuration_invalid');
export const clientTraceRelay = destination
	? createTraceRelay({ destination, fetch, health: telemetryHealth })
	: undefined;
let provider: NodeTracerProvider | undefined;
export const initializeServerTracing = () => {
	try {
		if (!destination) return;
		provider = new NodeTracerProvider({
			resource: resourceFromAttributes({
				'service.name': 'ripcord.server',
				'service.version': SERVER_VERSION,
				'ripcord.runtime': 'bun',
			}),
			sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.server.serverTracingSampleRate) }),
			spanProcessors: [
				new BatchSpanProcessor(
					withTraceDeliveryHealth(
						new OTLPTraceExporter({ url: destination.url, headers: destination.headers, timeoutMillis: 2000 }),
					),
					{ maxQueueSize: 256, maxExportBatchSize: 32, scheduledDelayMillis: 2000, exportTimeoutMillis: 2500 },
				),
			],
			spanLimits: { attributeCountLimit: 24, attributeValueLengthLimit: 200, eventCountLimit: 0, linkCountLimit: 0 },
		});
		provider.register();
		configureServerTracing(true);
	} catch {
		telemetryHealth.count('trace_initialize_failure');
		configureServerTracing(false);
	}
};
export const flushServerTracing = async () => {
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled([clientTraceRelay?.shutdown(), provider?.shutdown()]),
			new Promise<void>((resolve) => {
				deadline = setTimeout(() => {
					telemetryHealth.count('trace_shutdown_failure');
					resolve();
				}, 2500);
			}),
		]);
	} catch {
		/* Bounded shutdown. */
	} finally {
		clearTimeout(deadline);
	}
};
