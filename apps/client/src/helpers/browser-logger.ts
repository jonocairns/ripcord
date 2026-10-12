import { getActiveTraceContext } from '@sharkord/shared/telemetry/opentelemetry';
import { recordDesktopDiagnostic } from './desktop-diagnostics';
import {
	captureError,
	configureClientErrorReporting,
	getRuntimeTag,
	recordDiagnostic,
	setErrorReportingUser,
} from './error-reporting';
import { getVoiceDiagnosticContext } from './voice-diagnostic-context';
import { getVoiceDiagnosticMessage, type TVoiceDiagnosticMessage } from './voice-diagnostic-events';

const OVERRIDE_DEBUG = false;

const logDebug = (...args: unknown[]) => {
	const debugEnabled = typeof window !== 'undefined' && window.DEBUG;

	if (debugEnabled || OVERRIDE_DEBUG) {
		console.log('%c[DEBUG]', 'color: lightblue; font-weight: bold;', ...args);
	}
};

const recordVoiceDiagnostic = (
	message: TVoiceDiagnosticMessage,
	args: readonly unknown[],
	level: 'info' | 'warning' = 'info',
) => {
	try {
		recordDiagnostic({
			context: getVoiceDiagnosticContext(args),
			...getActiveTraceContext(),
			id: crypto.randomUUID(),
			occurredAt: Date.now(),
			kind: 'diagnostic',
			level,
			message: getVoiceDiagnosticMessage(message),
			runtime: getRuntimeTag(),
			release: typeof VITE_APP_VERSION === 'string' ? VITE_APP_VERSION : 'unknown',
			environment: import.meta.env.MODE,
		});
	} catch {
		/* Optional. */
	}
};
const logVoice = (message: string, ...details: unknown[]) => {
	const args = [message, ...details];
	recordDesktopDiagnostic('voice', { details: args });
	recordVoiceDiagnostic(getVoiceDiagnosticMessage(message), details);
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

export { configureClientErrorReporting, logDebug, logVoice, recordVoiceDiagnostic, reportError, setErrorReportingUser };
