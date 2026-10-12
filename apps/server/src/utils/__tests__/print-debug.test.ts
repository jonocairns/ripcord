import { expect, spyOn, test } from 'bun:test';
import { config } from '../../config';
import { logger } from '../../logger';
import { printDebug } from '../print-debug';

test('actual startup debug output cannot disclose private OTLP headers', () => {
	const originalDebug = config.server.debug;
	const originalHeaders = config.server.tracingOtlpHeaders;
	const originalEndpoint = config.server.tracingOtlpEndpoint;
	const originalDsn = config.server.serverErrorReportingSentryDsn;
	const messages: unknown[][] = [];
	const log = spyOn(logger, 'debug').mockImplementation((...args: unknown[]) => {
		messages.push(args);
		return logger;
	});
	try {
		config.server.debug = true;
		config.server.tracingOtlpEndpoint =
			'https://private-user:private-password@backend.invalid/secret-path?token=private-query';
		config.server.serverErrorReportingSentryDsn = 'https://private-key@sentry.invalid/1';
		config.server.tracingOtlpHeaders = '{"Authorization":"Bearer private-otel-token","X-API-Key":"private-api-key"}';
		printDebug();
		const output = JSON.stringify(messages);
		expect(output).toContain('[redacted]');
		expect(output).not.toContain('private-otel-token');
		expect(output).not.toContain('private-api-key');
		expect(output).not.toContain('private-key');
		expect(output).not.toContain('private-user');
		expect(output).not.toContain('private-password');
		expect(output).not.toContain('secret-path');
		expect(output).not.toContain('private-query');
		expect(config.server.tracingOtlpEndpoint).toContain('private-password');
		expect(config.server.serverErrorReportingSentryDsn).toContain('private-key');
		expect(config.server.tracingOtlpHeaders).toContain('private-otel-token');
	} finally {
		config.server.debug = originalDebug;
		config.server.tracingOtlpHeaders = originalHeaders;
		config.server.tracingOtlpEndpoint = originalEndpoint;
		config.server.serverErrorReportingSentryDsn = originalDsn;
		log.mockRestore();
	}
});
