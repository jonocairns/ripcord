import { expect, spyOn, test } from 'bun:test';
import * as Sentry from '@sentry/bun';
import { config } from '../config';
import { sentryFormat } from '../sentry';

test('client errors and health records never enter the server error adapter, while server errors do', () => {
	const previous = config.server.serverErrorReportingSentryDsn;
	config.server.serverErrorReportingSentryDsn = 'https://public@sentry.invalid/1';
	const capture = spyOn(Sentry.BunClient.prototype, 'captureException').mockReturnValue('event-id');
	const message = spyOn(Sentry.BunClient.prototype, 'captureMessage').mockReturnValue('event-id');
	const formatter = sentryFormat();
	try {
		for (const source of ['client', 'telemetry_health']) {
			const info = {
				source,
				level: 'error',
				[Symbol.for('level')]: 'error',
				message: 'failure',
				originalError: new Error('original'),
			};
			expect(formatter.transform(info, formatter.options)).toBe(info);
		}
		expect(capture).not.toHaveBeenCalled();
		expect(message).not.toHaveBeenCalled();
		const error = new Error('server failure');
		formatter.transform(
			{
				source: 'server',
				level: 'error',
				[Symbol.for('level')]: 'error',
				message: error.message,
				originalError: error,
			},
			formatter.options,
		);
		expect(capture).toHaveBeenCalledTimes(1);
		expect(capture.mock.calls[0]?.[0]).toBe(error);
		expect(message).not.toHaveBeenCalled();
	} finally {
		capture.mockRestore();
		message.mockRestore();
		config.server.serverErrorReportingSentryDsn = previous;
	}
});
