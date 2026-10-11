import { getActiveTraceContext } from '@sharkord/shared/telemetry/opentelemetry';
import { format } from 'winston';
import { SERVER_VERSION } from '../utils/env';

const { printf } = format;
export const serverLogFormat = printf((info) => {
	if (info[Symbol.for('level')] === 'error')
		return `${info.level}: [server-exception] ${JSON.stringify({ source: 'server', runtime: 'bun', occurredAt: Date.now(), message: info.message, 'exception.stacktrace': info.stack, 'exception.type': info.exceptionType, context: info.context, release: SERVER_VERSION, ...getActiveTraceContext() })}`;
	return `${info.level}: ${info.stack || info.message}`;
});
