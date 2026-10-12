import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { sanitizeDiagnosticText, type TClientTraceBatch } from '@sharkord/shared';

type TTraceAttributes = Record<string, string | number | boolean>;
const text = (value: string) => sanitizeDiagnosticText(value).slice(0, 200);
const attributes = (values: Record<string, unknown>): TTraceAttributes => {
	const result: TTraceAttributes = {};
	for (const [key, value] of Object.entries(values).slice(0, 32)) {
		if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key)) continue;
		if (
			typeof value !== 'string' &&
			typeof value !== 'boolean' &&
			!(typeof value === 'number' && Number.isFinite(value))
		)
			continue;
		result[key] = /authorization|cookie|token|secret|password|passwd|dsn|email|(?:^|[_.])ip(?:$|[_.])/i.test(key)
			? '[redacted]'
			: typeof value === 'string'
				? text(value)
				: value;
	}
	return result;
};

type TTraceLogRecord = {
	message: '[trace-span]';
	kind: 'trace';
	source: 'server' | 'client';
	serviceName: string;
	runtime: string;
	release: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	spanName: string;
	spanKind: number;
	status: 'unset' | 'ok' | 'error';
	occurredAt: number;
	endedAt: number;
	durationMs: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: TTraceAttributes;
	clientSessionId?: string;
	reporterUserId?: number;
};
type TTraceLog = (record: TTraceLogRecord) => void;
const times = (start: bigint, end: bigint) => ({
	occurredAt: Number(start / 1_000_000n),
	endedAt: Number(end / 1_000_000n),
	durationMs: Number(end - start) / 1_000_000,
	startTimeUnixNano: String(start),
	endTimeUnixNano: String(end),
});
const status = (code: number): TTraceLogRecord['status'] => (code === 2 ? 'error' : code === 1 ? 'ok' : 'unset');
const nano = (time: [number, number]) => BigInt(time[0]) * 1_000_000_000n + BigInt(time[1]);
const identity = (values: Record<string, unknown>, key: string) =>
	typeof values[key] === 'string' ? text(values[key]) : 'unknown';

const serverRecord = (span: ReadableSpan): TTraceLogRecord => ({
	message: '[trace-span]',
	kind: 'trace',
	source: 'server',
	serviceName: 'ripcord.server',
	runtime: 'bun',
	release: identity(span.resource.attributes, 'service.version'),
	traceId: span.spanContext().traceId,
	spanId: span.spanContext().spanId,
	parentSpanId: span.parentSpanContext?.spanId,
	spanName: text(span.name),
	spanKind: span.kind,
	status: status(span.status.code),
	...times(nano(span.startTime), nano(span.endTime)),
	attributes: attributes(span.attributes),
});

// A standard SDK exporter: buffering, sampling and shutdown remain SDK-owned.
export const createTraceLogExporter = (log: TTraceLog): SpanExporter => ({
	export: (spans, callback) => {
		let failed = false;
		for (const span of spans) {
			try {
				log(serverRecord(span));
			} catch {
				failed = true;
			}
		}
		callback({ code: failed ? ExportResultCode.FAILED : ExportResultCode.SUCCESS });
	},
	shutdown: async () => {},
});

// Input has already been validated, scrubbed and assigned authenticated identity
// by the relay. Never attach arbitrary resource metadata or recreate spans.
export const logClientTraceBatch = (batch: TClientTraceBatch, log: TTraceLog): void => {
	let failed = false;
	for (const resource of batch.resourceSpans) {
		const values: Record<string, unknown> = Object.fromEntries(
			resource.resource.attributes.map(({ key, value }) => [
				key,
				'stringValue' in value ? value.stringValue : 'intValue' in value ? value.intValue : undefined,
			]),
		);
		const reporter = Number(values['ripcord.reporter_user.id']);
		for (const scope of resource.scopeSpans)
			for (const span of scope.spans) {
				try {
					log({
						message: '[trace-span]',
						kind: 'trace',
						source: 'client',
						serviceName: 'ripcord.client',
						runtime: identity(values, 'ripcord.runtime'),
						release: identity(values, 'service.version'),
						clientSessionId: identity(values, 'ripcord.client_session.id'),
						...(Number.isSafeInteger(reporter) && reporter > 0 ? { reporterUserId: reporter } : {}),
						traceId: span.traceId,
						spanId: span.spanId,
						parentSpanId: span.parentSpanId,
						spanName: text(span.name),
						spanKind: span.kind,
						status: status(span.status.code),
						...times(BigInt(span.startTimeUnixNano), BigInt(span.endTimeUnixNano)),
						attributes: attributes(
							Object.fromEntries(
								span.attributes.map(({ key, value }) => [
									key,
									'stringValue' in value
										? value.stringValue
										: 'boolValue' in value
											? value.boolValue
											: 'intValue' in value
												? value.intValue
												: value.doubleValue,
								]),
							),
						),
					});
				} catch {
					failed = true;
				}
			}
	}
	if (failed) throw new Error('Client trace log write failed');
};
