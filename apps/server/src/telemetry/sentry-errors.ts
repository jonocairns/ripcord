import * as Sentry from '@sentry/bun';
import type { TDiagnosticRecord } from '@sharkord/shared';
import { withErrorDeliveryHealth } from './sentry-delivery-health';

export const createSentryErrorAdapter = (dsn: string, transport = Sentry.makeFetchTransport) => {
	let client: Sentry.BunClient | undefined;
	const forward = (record: TDiagnosticRecord, userId: number, clientSessionId: string): void => {
		if (!dsn || record.kind !== 'exception') return;
		client ??= new Sentry.BunClient({
			dsn,
			transport: withErrorDeliveryHealth(transport),
			stackParser: Sentry.defaultStackParser,
			integrations: [],
			sendDefaultPii: false,
			maxBreadcrumbs: 30,
		});
		const exception = record.exception;
		client.captureEvent({
			event_id: record.id.replaceAll('-', ''),
			timestamp: record.occurredAt / 1000,
			platform: 'javascript',
			release: record.release,
			environment: record.environment,
			level: record.level,
			user: { id: String(userId) },
			tags: { source: 'client', runtime: record.runtime, client_session_id: clientSessionId },
			contexts: {
				...(typeof record.context?.replayId === 'string' ? { replay: { replay_id: record.context.replayId } } : {}),
				...(record.traceId && record.spanId ? { trace: { trace_id: record.traceId, span_id: record.spanId } } : {}),
			},
			extra: record.context,
			breadcrumbs: record.breadcrumbs?.map((b) => ({
				timestamp: b.occurredAt / 1000,
				message: b.message,
				category: b.category,
			})),
			exception: exception
				? {
						values: [
							{
								type: exception.type,
								value: exception.message,
								stacktrace: {
									frames: exception.frames.map((f) => ({
										filename: f.filename,
										function: f.function,
										lineno: f.lineno,
										colno: f.colno,
									})),
								},
							},
						],
					}
				: undefined,
			debug_meta: {
				images: (exception?.frames ?? []).flatMap((f) =>
					f.debugId && f.filename ? [{ type: 'sourcemap', code_file: f.filename, debug_id: f.debugId }] : [],
				),
			},
		});
	};
	const flush = async (): Promise<void> => {
		try {
			await client?.close(2000);
		} catch {
			/* Best effort. */
		}
	};

	return { forward, flush };
};
