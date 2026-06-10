import * as Sentry from '@sentry/node';
import { format } from 'winston';
import { config } from './config';
import { IS_PRODUCTION, SERVER_VERSION } from './utils/env';

const SPLAT = Symbol.for('splat');

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

export { initSentry, Sentry, sentryFormat };
