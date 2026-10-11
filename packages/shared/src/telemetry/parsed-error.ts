import { sanitizeDiagnosticFrame, type TDiagnosticRecord } from './diagnostics';

type TParsedErrorEvent = {
	timestamp?: number;
	level?: string;
	message?: string;
	release?: string;
	environment?: string;
	exception?: {
		values?: {
			type?: string;
			value?: string;
			stacktrace?: { frames?: { filename?: string; function?: string; lineno?: number; colno?: number }[] };
		}[];
	};
	debug_meta?: { images?: { type: string; code_file?: string; debug_id?: string }[] };
	contexts?: { trace?: { trace_id?: string; span_id?: string }; reported_error?: Record<string, unknown> };
	extra?: Record<string, unknown>;
	breadcrumbs?: { timestamp?: number; message?: string; category?: string }[];
};
export const sdkEventRecord = (
	event: TParsedErrorEvent,
	hint: { originalException?: unknown },
	runtime: TDiagnosticRecord['runtime'],
): Omit<TDiagnosticRecord, 'sequence'> => {
	const exception = event.exception?.values?.[0];
	const debugImages = event.debug_meta?.images ?? [];
	const trace = event.contexts?.trace;
	const original = hint.originalException;
	return {
		id: crypto.randomUUID(),
		occurredAt: Math.round((event.timestamp ?? Date.now() / 1000) * 1000),
		kind: exception ? 'exception' : 'diagnostic',
		level: event.level === 'warning' ? 'warning' : event.level === 'info' ? 'info' : 'error',
		message: (event.message ?? exception?.value ?? 'Reported error').slice(0, 1000),
		runtime,
		release: (event.release ?? 'unknown').slice(0, 64),
		environment: (event.environment ?? 'unknown').slice(0, 64),
		exception: exception
			? {
					type: (exception.type ?? 'Error').slice(0, 1000),
					message: (exception.value ?? '').slice(0, 1000),
					stack: original instanceof Error ? original.stack?.slice(0, 8000) : undefined,
					frames: (exception.stacktrace?.frames ?? []).slice(-40).map((f) => ({
						filename: f.filename ? sanitizeDiagnosticFrame(f.filename) : undefined,
						function: f.function?.slice(0, 1000),
						lineno: f.lineno,
						colno: f.colno,
						debugId: debugImages.find((i) => i.type === 'sourcemap' && i.code_file === f.filename)?.debug_id,
					})),
				}
			: undefined,
		context: Object.fromEntries(
			Object.entries({ ...event.extra, ...event.contexts?.reported_error })
				.slice(0, 20)
				.flatMap(([k, v]) =>
					typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || v === null
						? [[k.slice(0, 80), typeof v === 'string' ? v.slice(0, 1000) : v]]
						: [],
				),
		),
		breadcrumbs: event.breadcrumbs?.slice(-30).map((b) => ({
			occurredAt: (b.timestamp ?? Date.now() / 1000) * 1000,
			message: (b.message ?? '').slice(0, 1000),
			category: b.category?.slice(0, 80),
		})),
		traceId: trace?.trace_id,
		spanId: trace?.span_id,
	};
};
