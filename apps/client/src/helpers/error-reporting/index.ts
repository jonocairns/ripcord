export const configureClientErrorReporting = (options: Parameters<typeof configureSdk>[0] = {}): void => {
	try {
		configureSdk(options);
	} catch {
		/* SDK initialization cannot break startup. */
	}
};

import { configureClientErrorReporting as configureSdk, reportErrorToSentry } from './sentry-client';
export const captureError = (message: string, error?: unknown, context?: unknown): void => {
	try {
		reportErrorToSentry(message, error, context);
	} catch {
		/* Optional SDK. */
	}
};
export { flushDiagnosticDelivery, recordDiagnostic } from './delivery';
export { getRuntimeTag, setErrorReportingIdentity, setSentryUser as setErrorReportingUser } from './sentry-client';
