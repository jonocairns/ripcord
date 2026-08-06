import {
	configureClientErrorReporting,
	reportErrorToSentry,
	setSentryUser,
	traceSentrySpan,
} from './error-reporting/sentry-client';

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

// Bound before Sentry.init() wraps the console (init runs at app startup, well
// after module evaluation), so this reference is always the unwrapped method.
// reportError reports to Sentry explicitly, so its console line must bypass
// captureConsoleIntegration. Otherwise every call emits two events: the explicit
// one, and a console-derived copy whose title is the joined arguments — e.g.
// "Voice reconnect recovery gave up undefined [object Object]". Those two group
// separately whenever `error` is not an Error instance, because the explicit
// path synthesizes `new Error(message)` with a different message and stack than
// the console copy, so dedupeIntegration cannot collapse them.
// Bare console.error sites elsewhere keep their intentional auto-capture.
const nativeConsoleError = console.error.bind(console);

const reportError = (message: string, error?: unknown, context?: unknown) => {
	nativeConsoleError(message, error, context);
	reportErrorToSentry(message, error, context);
};

export { configureClientErrorReporting, logDebug, logVoice, reportError, setSentryUser, traceSentrySpan };
