import { configureClientErrorReporting, reportErrorToSentry, traceSentrySpan } from './error-reporting/sentry-client';

const OVERRIDE_DEBUG = false;

const logDebug = (...args: unknown[]) => {
	const debugEnabled = typeof window !== 'undefined' && window.DEBUG;

	if (debugEnabled || OVERRIDE_DEBUG) {
		console.log('%c[DEBUG]', 'color: lightblue; font-weight: bold;', ...args);
	}
};

const logVoice = (...args: unknown[]) => {
	console.log('%c[VOICE-PROVIDER]', 'color: salmon; font-weight: bold;', ...args);
};

const reportError = (message: string, error?: unknown, context?: unknown) => {
	console.error(message, error, context);
	reportErrorToSentry(message, error, context);
};

export { configureClientErrorReporting, logDebug, logVoice, reportError, traceSentrySpan };
