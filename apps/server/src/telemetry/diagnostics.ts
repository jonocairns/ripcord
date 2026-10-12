import { config } from '../config';
import { logger } from '../logger';
import { createDiagnosticIngest } from './diagnostic-ingest';
import { telemetryHealth } from './health';
import { createSentryErrorAdapter } from './sentry-errors';

const adapter = createSentryErrorAdapter(config.server.clientErrorReportingSentryDsn.trim());
export const flushClientErrorAdapter = adapter.flush;
export const diagnosticIngest = createDiagnosticIngest({
	log: ({ record, ...identity }) =>
		logger.log({
			...record,
			level: record.level === 'warning' ? 'warn' : record.level,
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
	forward: adapter.forward,
	health: telemetryHealth,
});
