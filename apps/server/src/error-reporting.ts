import { logger } from './logger';
export const reportServerError = (error: unknown, context?: Record<string, unknown>): void => {
	try {
		logger.error({
			message: error instanceof Error ? error.message : String(error),
			originalError: error,
			stack: error instanceof Error ? error.stack : undefined,
			exceptionType: error instanceof Error ? error.name : 'Error',
			context,
		});
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
