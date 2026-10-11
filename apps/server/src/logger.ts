import path from 'node:path';
import { createLogger, format, transports } from 'winston';
import { config } from './config';
import { bootLog } from './helpers/boot-log';
import { ensureDir } from './helpers/fs';
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

bootLog('logger: creating transports');
const logger = createLogger({
	level,
	format: combine(serverErrorFormat(), splat(), errors({ stack: true }), sentryFormat(), uncolorize(), serverLogFormat),
	transports: [
		new transports.Console(),
		new transports.File({
			filename: appLog,
			level,
		}),
		new transports.File({
			filename: errorLog,
			level: 'error',
		}),
	],
});
setTelemetryHealthReporter((summary) => logger.warn(summary));
bootLog('logger: ready');

export { logger };
