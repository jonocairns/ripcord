import { getActiveTraceContext } from '@sharkord/shared/telemetry/opentelemetry';

type ErrorTraceContext = ReturnType<typeof getActiveTraceContext>;
const contexts = new WeakMap<object, ErrorTraceContext>();

// tRPC reports failures after leaving the handler's async context. Associate
// its per-call error wrapper with the original RPC span, without another report.
export const rememberErrorTraceContext = (error: object): void => {
	try {
		const context = getActiveTraceContext();
		if (context.traceId && context.spanId) contexts.set(error, context);
	} catch {
		/* Observability cannot change the handler result. */
	}
};

export const consumeErrorTraceContext = (error: object): ErrorTraceContext | undefined => {
	const context = contexts.get(error);
	contexts.delete(error);
	return context;
};

export const getReportedTraceContext = (record: Record<string, unknown>): ErrorTraceContext =>
	typeof record.traceId === 'string' && typeof record.spanId === 'string'
		? { traceId: record.traceId, spanId: record.spanId }
		: getActiveTraceContext();
