import path from 'node:path';
import { createLogger, format, transports } from 'winston';
import { config } from './config';
import { bootLog } from './helpers/boot-log';
import { ensureDir } from './helpers/fs';
import { createRotatingFileTransport } from './helpers/log-retention';
import { LOGS_PATH } from './helpers/paths';
import { serverErrorFormat, serverLogFormat } from './helpers/server-log-format';
import { sentryFormat } from './sentry';
import { setTelemetryHealthReporter } from './telemetry/health';

const { combine, errors, splat, uncolorize } = format;

const appLog = path.join(LOGS_PATH, 'app.log');
const errorLog = path.join(LOGS_PATH, 'error.log');

bootLog('logger: ensuring log directory');
await ensureDir(LOGS_PATH);
bootLog('logger: log directory ready');

const level = config.server.debug ? 'debug' : 'info';
const retention = { maxSizeBytes: config.server.logMaxSizeMb * 1024 * 1024, maxFiles: config.server.logMaxFiles };

bootLog('logger: creating transports');
const logger = createLogger({
	level,
	format: combine(serverErrorFormat(), splat(), errors({ stack: true }), sentryFormat(), uncolorize(), serverLogFormat),
	transports: [
		new transports.Console(),
		createRotatingFileTransport(appLog, level, retention),
		createRotatingFileTransport(errorLog, 'error', retention),
	],
});
setTelemetryHealthReporter((summary) => logger.warn(summary));
bootLog('logger: ready');

export { logger };
