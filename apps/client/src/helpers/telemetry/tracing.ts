import { createTracing, type TTracingAdapter } from '@sharkord/shared/telemetry/tracing';

let adapter: TTracingAdapter | undefined;
const tracing = createTracing(
	{
		start: (options) => {
			if (!adapter) throw new Error('Tracing is disabled');
			return adapter.start(options);
		},
	},
	() => adapter !== undefined,
);

// The authenticated server capability installs the standard OTel adapter.
const configureClientTracing = (configuredAdapter: TTracingAdapter | undefined): void => {
	adapter = configuredAdapter;
};

const { traceSpan, startSpanObservation } = tracing;

export { configureClientTracing, startSpanObservation, traceSpan };
