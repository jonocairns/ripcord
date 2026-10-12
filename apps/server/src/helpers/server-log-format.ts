import { getActiveTraceContext } from '@sharkord/shared/telemetry/opentelemetry';
import { format } from 'winston';
import { SERVER_VERSION } from '../utils/env';

// Winston splat() consumes trailing metadata. Preserve the Error before it loses
// non-enumerable stack/name fields so structured logs and adapters see one cause.
export const serverErrorFormat = format((info) => {
	const splat: unknown = info[Symbol.for('splat')];
	const originalError =
		info.originalError instanceof Error
			? info.originalError
			: info instanceof Error
				? info
				: Array.isArray(splat)
					? splat.find((value): value is Error => value instanceof Error)
					: undefined;
	if (originalError && info.source !== 'client') {
		info.originalError = originalError;
		info.stack ??= originalError.stack;
		info.exceptionType ??= originalError.name;
	}
	return info;
});

// Preserve explicitly captured context (including forwarded client context) before
// considering the active server span. Never label a client record as a server span.
export const serverLogFormat = format.combine(
	format((info) => {
		const splat: unknown = info[Symbol.for('splat')];
		const originalError =
			info.originalError instanceof Error
				? info.originalError
				: Array.isArray(splat)
					? splat.find((value): value is Error => value instanceof Error)
					: undefined;
		const { originalError: _originalError, ...fields } = info;
		const stack = typeof info.stack === 'string' ? info.stack : originalError?.stack;
		const activeContext = info.source === 'client' || info.source === 'telemetry_health' ? {} : getActiveTraceContext();
		return {
			source: 'server',
			...(info.source === 'client' ? {} : { runtime: 'bun', release: SERVER_VERSION }),
			occurredAt: Date.now(),
			...activeContext,
			...fields,
			level: typeof info[Symbol.for('level')] === 'string' ? String(info[Symbol.for('level')]) : info.level,
			observedAt: Date.now(),
			...(stack && info.source !== 'client'
				? { 'exception.stacktrace': stack, 'exception.type': info.exceptionType ?? originalError?.name ?? 'Error' }
				: {}),
		};
	})(),
	format.json(),
);
