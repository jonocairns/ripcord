import path from 'node:path';
import { createLogger, format, transports } from 'winston';
import { config } from './config';
import { bootLog } from './helpers/boot-log';
import { ensureDir } from './helpers/fs';
import { LOGS_PATH } from './helpers/paths';
import { sentryFormat } from './sentry';

const { combine, colorize, printf, errors, splat } = format;

const logFormat = printf(({ level, message, stack }) => {
	return `${level}: ${stack || message}`;
});

const appLog = path.join(LOGS_PATH, 'app.log');
const errorLog = path.join(LOGS_PATH, 'error.log');

bootLog('logger: ensuring log directory');
await ensureDir(LOGS_PATH);
bootLog('logger: log directory ready');

const level = config.server.debug ? 'debug' : 'info';

bootLog('logger: creating transports');
const logger = createLogger({
	level,
	format: combine(colorize(), splat(), errors({ stack: true }), sentryFormat(), logFormat),
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
bootLog('logger: ready');

export { logger };
