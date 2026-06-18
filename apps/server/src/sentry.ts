// The server runs on Bun (compiled single-file binary in production), so use
// the first-class @sentry/bun SDK rather than @sentry/node. It re-exports the
// Node API — captureException, captureMessage, close, etc. all behave the same
// — but is built for the Bun runtime. Note: Sentry auto-instrumentation (and
// thus tracesSampleRate) does not attach inside a compiled single-file
// executable; error capture, which is what we rely on, is unaffected.
import * as Sentry from '@sentry/bun';
import { format } from 'winston';
import { config } from './config';
import { IS_PRODUCTION, SERVER_VERSION } from './utils/env';

const SPLAT = Symbol.for('splat');

// Flush buffered events before the process exits. Safe to call when Sentry was
// never initialised (no DSN) — close() resolves immediately. The graceful-
// shutdown orchestrator owns the termination signals and sequences this flush
// just before the final process exit, so events captured moments before
// shutdown aren't lost.
const flushSentry = async (): Promise<void> => {
	try {
		await Sentry.close(2000);
	} catch {
		// Flush failed (network/SDK error) — never block shutdown on telemetry.
	}
};

const initSentry = (): void => {
	const dsn = config.server.serverErrorReportingSentryDsn.trim();

	if (!dsn) {
		return;
	}

	const serverTracingSampleRate = config.server.serverTracingSampleRate;
	const tracingOptions = serverTracingSampleRate > 0 ? { tracesSampleRate: serverTracingSampleRate } : {};

	Sentry.init({
		dsn,
		environment: IS_PRODUCTION ? 'production' : 'development',
		release: SERVER_VERSION,
		sendDefaultPii: false,
		...tracingOptions,
	});
};

const sentryFormat = format((info) => {
	if (info.level !== 'error') {
		return info;
	}

	const splat = (info as Record<symbol, unknown[]>)[SPLAT] ?? [];
	const errorFromSplat = splat.find((arg): arg is Error => arg instanceof Error);
	const additionalSplat = splat.filter((arg) => arg !== errorFromSplat);

	const extra: Record<string, unknown> = {
		message: String(info.message),
	};

	if (additionalSplat.length > 0) {
		extra.splat = additionalSplat;
	}

	if (errorFromSplat) {
		Sentry.captureException(errorFromSplat, { extra });
	} else if (info instanceof Error) {
		Sentry.captureException(info, { extra });
	} else {
		Sentry.captureMessage(String(info.message), {
			level: 'error',
			extra,
		});
	}

	return info;
});

export { flushSentry, initSentry, Sentry, sentryFormat };
