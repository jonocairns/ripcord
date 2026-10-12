import { getActiveTraceContext } from '@sharkord/shared/telemetry/opentelemetry';
import { recordDesktopDiagnostic } from './desktop-diagnostics';
import {
	captureError,
	configureClientErrorReporting,
	getRuntimeTag,
	recordDiagnostic,
	setErrorReportingUser,
} from './error-reporting';

const OVERRIDE_DEBUG = false;

const logDebug = (...args: unknown[]) => {
	const debugEnabled = typeof window !== 'undefined' && window.DEBUG;

	if (debugEnabled || OVERRIDE_DEBUG) {
		console.log('%c[DEBUG]', 'color: lightblue; font-weight: bold;', ...args);
	}
};

const logVoice = (...args: unknown[]) => {
	recordDesktopDiagnostic('voice', { details: args });
	try {
		recordDiagnostic({
			context: Object.fromEntries(
				args
					.flatMap((value) => {
						if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
						return Object.entries(value).filter(
							([key, v]) =>
								/^(channelId|userId|producerId|consumerId|transportId|operationId|reconnectAttemptId)$/.test(key) &&
								(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'),
						);
					})
					.slice(0, 20),
			),
			...getActiveTraceContext(),
			id: crypto.randomUUID(),
			occurredAt: Date.now(),
			kind: 'diagnostic',
			level: 'info',
			message: args
				.filter((v) => typeof v === 'string')
				.join(' ')
				.slice(0, 1000),
			runtime: getRuntimeTag(),
			release: typeof VITE_APP_VERSION === 'string' ? VITE_APP_VERSION : 'unknown',
			environment: import.meta.env.MODE,
		});
	} catch {
		/* Optional. */
	}
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
	recordDesktopDiagnostic('reported_error', { message, error, context }, 'error');
	nativeConsoleError(message, error, context);
	captureError(message, error, context);
};

export { configureClientErrorReporting, logDebug, logVoice, reportError, setErrorReportingUser };
