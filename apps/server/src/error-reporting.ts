import { logger } from './logger';
export const reportServerError = (error: unknown, context?: Record<string, unknown>): void => {
	try {
		logger.error('[server-exception] %s', error instanceof Error ? error.message : String(error), error, context);
	} catch {
		/* Reporting cannot affect RPCs. */
	}
};
export const reportServerDiagnostic = (message: string, context: Record<string, unknown>): void => {
	try {
		logger.warn('[server-diagnostic] %s %o', message, context);
	} catch {
		/* Optional. */
	}
};
