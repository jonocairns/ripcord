import { expect, spyOn, test } from 'bun:test';
import { format } from 'winston';
import { reportServerError } from '../error-reporting';
import { serverLogFormat } from '../helpers/server-log-format';
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
	const pipeline = format.combine(format.colorize(), format.splat(), format.errors({ stack: true }), serverLogFormat);
	const formatted = pipeline.transform(info, pipeline.options);
	if (!formatted || typeof formatted !== 'object') throw new Error('Missing formatted log');
	const output = String(formatted[Symbol.for('message')]);
	expect(output).toContain('voice.join');
	expect(output).toContain('TypeError');
	expect(output).toContain('server-errors.test.ts');
	expect(output).toContain('"source":"server"');
	expect(output).toContain('"release":');
});
