import { expect, spyOn, test } from 'bun:test';
import { format } from 'winston';
import { reportServerError } from '../error-reporting';
import { serverErrorFormat, serverLogFormat } from '../helpers/server-log-format';
import { logger } from '../logger';

test('RPC reporting retains original stack and context through the actual Winston formatter', () => {
	const error = new TypeError('backend failed');
	let record: unknown;
	const spy = spyOn(logger, 'error').mockImplementation((...args: unknown[]) => {
		record = args[0];
		return logger;
	});
	try {
		reportServerError(error, { path: 'voice.join' });
	} finally {
		spy.mockRestore();
	}
	if (!record || typeof record !== 'object' || !('message' in record) || !('stack' in record))
		throw new Error('Missing structured record');
	expect(record.stack).toBe(error.stack);
	const info = { ...record, level: 'error', message: record.message, [Symbol.for('level')]: 'error' };
	const pipeline = format.combine(serverErrorFormat(), format.splat(), format.errors({ stack: true }), serverLogFormat);
	const formatted = pipeline.transform(info, pipeline.options);
	if (!formatted || typeof formatted !== 'object') throw new Error('Missing formatted log');
	const output = String(formatted[Symbol.for('message')]);
	expect(output).toContain('voice.join');
	expect(output).toContain('TypeError');
	expect(output).toContain('server-errors.test.ts');
	expect(output).toContain('"source":"server"');
	expect(output).toContain('"release":');
});

test('JSON logs preserve client severity/time/context without assigning server release or span identity', () => {
	const info = {
		level: 'error',
		[Symbol.for('level')]: 'error',
		source: 'client',
		message: 'client failed',
		occurredAt: 100,
		receivedAt: 200,
		release: 'client-release',
		runtime: 'desktop',
		traceId: 'a'.repeat(32),
		spanId: 'b'.repeat(16),
		exception: { frames: [{ filename: 'app.js', lineno: 5 }] },
		'exception.stacktrace': 'original client stack',
	};
	const result = serverLogFormat.transform(info, serverLogFormat.options);
	if (!result || typeof result !== 'object') throw new Error('Missing result');
	const record: unknown = JSON.parse(String(result[Symbol.for('message')]));
	expect(record).toMatchObject({
		level: 'error',
		source: 'client',
		occurredAt: 100,
		receivedAt: 200,
		release: 'client-release',
		traceId: 'a'.repeat(32),
		spanId: 'b'.repeat(16),
		'exception.stacktrace': 'original client stack',
	});
});

test('normal and splat errors produce uncolored JSON with original exception type and stack', () => {
	const error = new TypeError('failure');
	const pipeline = format.combine(
		serverErrorFormat(),
		format.splat(),
		format.errors({ stack: true }),
		format.uncolorize(),
		serverLogFormat,
	);
	const result = pipeline.transform(
		{
			level: 'error',
			[Symbol.for('level')]: 'error',
			message: '\u001b[31mFailed %s\u001b[39m',
			[Symbol.for('splat')]: ['operation', error],
		},
		pipeline.options,
	);
	if (!result || typeof result !== 'object') throw new Error('Missing result');
	const output = String(result[Symbol.for('message')]);
	expect(output).not.toContain('\\u001b');
	const record: unknown = JSON.parse(output);
	expect(record).toMatchObject({
		level: 'error',
		source: 'server',
		message: 'Failed operation',
		runtime: 'bun',
		'exception.type': 'TypeError',
		'exception.stacktrace': error.stack,
	});
});

test('client stream events with no runtime/release do not inherit server identity', () => {
	const result = serverLogFormat.transform(
		{
			message: '[stream-event]',
			level: 'info',
			[Symbol.for('level')]: 'info',
			source: 'client',
			clientVersion: 'client-version',
			occurredAt: 100,
		},
		serverLogFormat.options,
	);
	if (!result || typeof result !== 'object') throw new Error('Missing result');
	const record: unknown = JSON.parse(String(result[Symbol.for('message')]));
	expect(record).toMatchObject({ source: 'client', clientVersion: 'client-version', occurredAt: 100 });
	expect(record).not.toHaveProperty('runtime');
	expect(record).not.toHaveProperty('release');
	expect(record).not.toHaveProperty('traceId');
	expect(record).not.toHaveProperty('spanId');
});
