import { z } from '../zod';

// The transport accepts records, never SDK envelopes, attachments or arbitrary objects.
const text = z.string().max(1000);
const primitive = z.union([text, z.number().finite(), z.boolean(), z.null()]);
export const diagnosticFrameSchema = z
	.object({
		filename: z.string().max(500).optional(),
		function: text.optional(),
		lineno: z.number().int().min(0).max(10_000_000).optional(),
		colno: z.number().int().min(0).max(10_000_000).optional(),
		debugId: z.string().uuid().optional(),
	})
	.strict();
export const diagnosticRecordSchema = z
	.object({
		id: z.string().uuid(),
		occurredAt: z.number().int().min(0).max(8_640_000_000_000_000),
		sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		kind: z.enum(['exception', 'diagnostic']),
		level: z.enum(['error', 'warning', 'info', 'debug']),
		message: text,
		runtime: z.enum(['web', 'desktop', 'desktop-main']),
		release: z.string().regex(/^[a-zA-Z0-9.+_-]{1,64}$/),
		environment: z.string().max(64),
		exception: z
			.object({
				type: text,
				message: text,
				stack: z.string().max(8000).optional(),
				frames: z.array(diagnosticFrameSchema).max(40),
			})
			.strict()
			.optional(),
		context: z
			.record(z.string().max(80), primitive)
			.refine((v) => Object.keys(v).length <= 20)
			.optional(),
		breadcrumbs: z
			.array(
				z.object({ occurredAt: z.number().finite(), message: text, category: z.string().max(80).optional() }).strict(),
			)
			.max(30)
			.optional(),
		traceId: z
			.string()
			.regex(/^[0-9a-f]{32}$/)
			.optional(),
		spanId: z
			.string()
			.regex(/^[0-9a-f]{16}$/)
			.optional(),
	})
	.strict()
	.refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= 11_000, 'Record too large');
export const diagnosticBatchSchema = z
	.object({
		clientSessionId: z.string().uuid(),
		droppedEvents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		records: z.array(diagnosticRecordSchema).min(1).max(8),
	})
	.strict()
	.refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= 96_000, 'Batch too large');
export type TDiagnosticRecord = z.infer<typeof diagnosticRecordSchema>;
export type TDiagnosticBatch = z.infer<typeof diagnosticBatchSchema>;

export const sanitizeDiagnosticText = (value: string): string =>
	value
		.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
		.replace(/https?:\/\/[^\s)"']+/gi, '[redacted-url]')
		.replace(/(?:file:\/\/)?(?:\/[Uu]sers|\/home)\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+/g, '~')
		.replace(/(password|token|secret|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]');
// Asset paths are useful for symbolication; exclude credentials/query and local account paths.
export const sanitizeDiagnosticFrame = (filename: string): string => {
	try {
		const url = new URL(filename);
		if (url.protocol === 'https:' || url.protocol === 'http:') return `${url.origin}${url.pathname}`.slice(0, 500);
	} catch {
		/* Local frame. */
	}
	return sanitizeDiagnosticText(filename).slice(0, 500);
};
export const sanitizeDiagnosticRecord = (record: TDiagnosticRecord): TDiagnosticRecord => ({
	...record,
	message: sanitizeDiagnosticText(record.message),
	context: record.context
		? Object.fromEntries(
				Object.entries(record.context).map(([key, value]) => [
					key,
					/(?:authorization|cookie|token|secret|password|passwd|dsn|email|^ip$)/i.test(key)
						? '[redacted]'
						: typeof value === 'string'
							? sanitizeDiagnosticText(value)
							: value,
				]),
			)
		: undefined,
	breadcrumbs: record.breadcrumbs?.map((b) => ({
		...b,
		message: sanitizeDiagnosticText(b.message),
		category: b.category ? sanitizeDiagnosticText(b.category) : undefined,
	})),
	exception: record.exception
		? {
				...record.exception,
				type: sanitizeDiagnosticText(record.exception.type),
				message: sanitizeDiagnosticText(record.exception.message),
				stack: record.exception.stack ? sanitizeDiagnosticText(record.exception.stack) : undefined,
				frames: record.exception.frames.map((f) => ({
					...f,
					filename: f.filename ? sanitizeDiagnosticFrame(f.filename) : undefined,
					function: f.function ? sanitizeDiagnosticText(f.function) : undefined,
				})),
			}
		: undefined,
});
