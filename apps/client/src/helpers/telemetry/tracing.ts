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

// The browser SDK adapter is installed at the same time as error reporting.
// No second global provider competes with Sentry's browser async context.
const configureClientTracing = (configuredAdapter: TTracingAdapter): void => {
	adapter = configuredAdapter;
};

const { traceSpan, startSpanObservation } = tracing;

export { configureClientTracing, startSpanObservation, traceSpan };
