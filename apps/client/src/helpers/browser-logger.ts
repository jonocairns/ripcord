import {
	captureConsoleError,
	configureClientErrorReporting,
	getSentryTunnelUrl,
	reportErrorToSentry,
	syncSentryConfiguration,
} from './error-reporting/sentry-client';

const OVERRIDE_DEBUG = false;

const rawConsole = {
	log: console.log.bind(console),
	error: console.error.bind(console),
};

let consolePatched = false;

const patchConsole = () => {
	if (consolePatched) {
		return;
	}

	console.error = (...args: unknown[]) => {
		rawConsole.error(...args);
		void captureConsoleError(args);
	};

	consolePatched = true;
};

const initializeClientLogger = async () => {
	patchConsole();
};

const logDebug = (...args: unknown[]) => {
	if (window.DEBUG || OVERRIDE_DEBUG) {
		rawConsole.log('%c[DEBUG]', 'color: lightblue; font-weight: bold;', ...args);
	}
};

const logVoice = (...args: unknown[]) => {
	rawConsole.log('%c[VOICE-PROVIDER]', 'color: salmon; font-weight: bold;', ...args);
};

const logError = (...args: unknown[]) => {
	rawConsole.error(...args);
};

const reportError = (message: string, error?: unknown, context?: unknown) => {
	rawConsole.error(message, error, context);
	void reportErrorToSentry(message, error, context);
};

export {
	configureClientErrorReporting,
	getSentryTunnelUrl,
	initializeClientLogger,
	logDebug,
	logError,
	logVoice,
	reportError,
	syncSentryConfiguration,
};
