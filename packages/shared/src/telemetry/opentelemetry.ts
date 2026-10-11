import { context, trace } from '@opentelemetry/api';
import type { TTracingAdapter } from './tracing';

// Resolve the tracer on demand: SDK initialization happens after module imports.
const createOpenTelemetryAdapter = (instrumentationName: string): TTracingAdapter => ({
	start: ({ name, attributes }) => {
		const parent = context.active();
		const span = trace.getTracer(instrumentationName).startSpan(name, { attributes }, parent);
		const active = trace.setSpan(parent, span);
		return {
			run: (effect) => context.with(active, effect),
			setAttributes: (values) => {
				span.setAttributes(values);
			},
			setStatus: (status) => {
				span.setStatus(status);
			},
			end: () => span.end(),
		};
	},
});

export { createOpenTelemetryAdapter };
