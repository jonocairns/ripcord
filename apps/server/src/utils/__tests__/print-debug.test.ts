import { expect, spyOn, test } from 'bun:test';
import { config } from '../../config';
import { printDebug } from '../print-debug';

test('actual startup debug output cannot disclose private OTLP headers', () => {
	const originalDebug = config.server.debug;
	const originalHeaders = config.server.tracingOtlpHeaders;
	const messages: unknown[][] = [];
	const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		messages.push(args);
	});
	try {
		config.server.debug = true;
		config.server.tracingOtlpHeaders = '{"Authorization":"Bearer private-otel-token","X-API-Key":"private-api-key"}';
		printDebug();
		const output = JSON.stringify(messages);
		expect(output).toContain('[redacted]');
		expect(output).not.toContain('private-otel-token');
		expect(output).not.toContain('private-api-key');
		expect(config.server.tracingOtlpHeaders).toContain('private-otel-token');
	} finally {
		config.server.debug = originalDebug;
		config.server.tracingOtlpHeaders = originalHeaders;
		log.mockRestore();
	}
});
