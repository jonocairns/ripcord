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

  Sentry.init({
    dsn,
    environment: IS_PRODUCTION ? 'production' : 'development',
    release: SERVER_VERSION,
    sendDefaultPii: false,
  });
};

const sentryFormat = format((info) => {
  if (info.level !== 'error') {
    return info;
  }

  const splat = (info as Record<symbol, unknown[]>)[SPLAT] ?? [];
  const firstSplatArg = splat[0];

  if (firstSplatArg instanceof Error) {
    Sentry.captureException(firstSplatArg, { extra: { message: String(info.message) } });
  } else if (info instanceof Error) {
    Sentry.captureException(info);
  } else {
    Sentry.captureMessage(String(info.message), 'error');
  }

  return info;
});

export { initSentry, Sentry, sentryFormat };
