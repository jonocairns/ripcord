import { createOpenTelemetryAdapter } from '@sharkord/shared/telemetry/opentelemetry';
import { createTracing } from '@sharkord/shared/telemetry/tracing';

let enabled = false;
const configureServerTracing = (tracingEnabled: boolean): void => {
	enabled = tracingEnabled;
};

const { startSpanObservation } = createTracing(createOpenTelemetryAdapter('ripcord.server'), () => enabled);

export { configureServerTracing, startSpanObservation };
