import { config } from '../config';
import { logger } from '../logger';
import { createDiagnosticIngest } from './diagnostic-ingest';
import { createSentryErrorAdapter } from './sentry-errors';

const adapter = createSentryErrorAdapter(config.server.clientErrorReportingSentryDsn.trim());
export const flushClientErrorAdapter = adapter.flush;
export const diagnosticIngest = createDiagnosticIngest({
	log: ({ record, ...identity }) =>
		logger.info(
			'[client-telemetry] %s',
			JSON.stringify({
				...record,
				...identity,
				source: 'client',
				...(record.exception
					? {
							'exception.type': record.exception.type,
							'exception.message': record.exception.message,
							'exception.stacktrace': record.exception.stack,
						}
					: {}),
			}),
		),
	forward: adapter.forward,
});
