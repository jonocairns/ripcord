import { ExportResultCode } from '@opentelemetry/core';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { telemetryHealth } from './health';

// A public exporter decorator only: the standard SDK/exporter still own spans,
// buffering, retries, deadlines and lifecycle. Health must never change callbacks.
export const withTraceDeliveryHealth = (
	exporter: SpanExporter,
	health: Pick<typeof telemetryHealth, 'count'> = telemetryHealth,
): SpanExporter => {
	const count: typeof health.count = (reason, quantity = 1) => {
		try {
			health.count(reason, quantity);
		} catch {
			/* Optional health is isolated. */
		}
	};
	const forceFlush = exporter.forceFlush?.bind(exporter);
	return {
		export: (spans, callback) => {
			let completed = false;
			try {
				exporter.export(spans, (result) => {
					completed = true;
					if (result.code === ExportResultCode.FAILED) {
						count('trace_export_failure');
						count('trace_export_failed_spans', spans.length);
					}
					callback(result);
				});
			} catch (error) {
				if (!completed) {
					count('trace_export_failure');
					count('trace_export_failed_spans', spans.length);
				}
				throw error;
			}
		},
		shutdown: async () => {
			try {
				await exporter.shutdown();
			} catch (error) {
				count('trace_shutdown_failure');
				throw error;
			}
		},
		...(forceFlush ? { forceFlush } : {}),
	};
};
