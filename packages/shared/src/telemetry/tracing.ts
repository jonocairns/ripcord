import type { Attributes, SpanStatus } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';

type TSpanOptions = {
	name: string;
	op?: string;
	attributes?: Record<string, string | number | boolean | undefined>;
};

type TSpanFinishOptions = {
	attributes?: TSpanOptions['attributes'];
	status: 'ok' | 'error' | 'unset';
	statusMessage?: string;
};

type TSpanObservation = {
	run: <T>(effect: () => T) => T;
	finish: (options: TSpanFinishOptions) => void;
};

type TTracingAdapter = {
	start: (options: { name: string; attributes: Attributes }) => {
		run: <T>(effect: () => T) => T;
		setAttributes: (attributes: Attributes) => void;
		setStatus: (status: SpanStatus) => void;
		end: () => void;
	};
};

// Only bounded primitive metadata belongs in spans. Never send raw errors,
// request payloads, device labels, or credentials through this boundary.
const sanitizeTraceString = (value: string): string =>
	value
		.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
		.replace(/https?:\/\/[^\s)"']+/gi, '[redacted-url]')
		.slice(0, 200);

const sanitizeTraceAttributes = (attributes: TSpanOptions['attributes']): Attributes => {
	const sanitized: Attributes = {};
	for (const [key, value] of Object.entries(attributes ?? {}).slice(0, 20)) {
		if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) continue;
		const tokens = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/);
		if (tokens.some((token) => /^(authorization|cookie|token|secret|password|passwd|dsn|email|ip)$/i.test(token))) {
			sanitized[key] = '[redacted]';
		} else {
			sanitized[key] = typeof value === 'string' ? sanitizeTraceString(value) : value;
		}
	}
	return sanitized;
};

const safely = (effect: () => void): void => {
	try {
		effect();
	} catch {
		// Observability must never change application behavior.
	}
};

const noOpObservation: TSpanObservation = { run: (effect) => effect(), finish: () => {} };

const createTracing = (adapter: TTracingAdapter, isEnabled: () => boolean = () => true) => {
	const startSpanObservation = (options: TSpanOptions): TSpanObservation => {
		try {
			if (!isEnabled()) return noOpObservation;
			const span = adapter.start({
				name: sanitizeTraceString(options.name),
				attributes: {
					...sanitizeTraceAttributes(options.attributes),
					...(options.op ? { 'ripcord.operation': sanitizeTraceString(options.op) } : {}),
				},
			});
			let finished = false;
			return {
				run: <T>(effect: () => T): T => {
					if (finished) return effect();
					let result: { value: T } | undefined;
					let failure: { error: unknown } | undefined;
					const runOnce = (): T => {
						if (failure) throw failure.error;
						if (result) return result.value;
						try {
							const value = effect();
							result = { value };
							return value;
						} catch (error) {
							failure = { error };
							throw error;
						}
					};
					try {
						return span.run(runOnce);
					} catch {
						// An SDK may throw before entering or after leaving the callback.
						// Retry context setup failures, never application side effects.
						return runOnce();
					}
				},
				finish: ({ attributes, status, statusMessage }) => {
					if (finished) return;
					finished = true;
					safely(() => span.setAttributes(sanitizeTraceAttributes(attributes)));
					safely(() =>
						span.setStatus({
							code:
								status === 'ok' ? SpanStatusCode.OK : status === 'error' ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
							message: statusMessage ? sanitizeTraceString(statusMessage) : undefined,
						}),
					);
					safely(() => span.end());
				},
			};
		} catch {
			return noOpObservation;
		}
	};

	function traceSpan<T>(options: TSpanOptions, effect: () => Promise<T>): Promise<T>;
	function traceSpan<T>(options: TSpanOptions, effect: () => T): T;
	function traceSpan<T>(options: TSpanOptions, effect: () => T | Promise<T>): T | Promise<T> {
		const observation = startSpanObservation(options);
		try {
			const result = observation.run(effect);
			if (result instanceof Promise) {
				return result.then(
					(value) => {
						observation.finish({ status: 'ok' });
						return value;
					},
					(error: unknown) => {
						observation.finish({ status: 'error' });
						throw error;
					},
				);
			}
			observation.finish({ status: 'ok' });
			return result;
		} catch (error) {
			observation.finish({ status: 'error' });
			throw error;
		}
	}
	return { startSpanObservation, traceSpan };
};

export type { TSpanObservation, TSpanOptions, TTracingAdapter };
export { createTracing };
