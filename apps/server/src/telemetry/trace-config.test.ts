import { expect, test } from 'bun:test';
import { parseTraceDestination, resolveTraceOutputs } from './trace-config';

test('destination is independently opt-in and credentials are server-side headers with strict config', () => {
	expect(parseTraceDestination('', '{}')).toBeUndefined();
	expect(parseTraceDestination('https://backend/v1/traces', '{"Authorization":"Bearer server-secret"}')).toEqual({
		url: 'https://backend/v1/traces',
		headers: { Authorization: 'Bearer server-secret' },
	});
	for (const endpoint of [
		'file:///etc/passwd',
		'https://user:pass@backend/v1/traces',
		'https://backend/v1/traces?token=secret',
		'bad',
	])
		expect(parseTraceDestination(endpoint, '{}')).toBeUndefined();
	for (const headers of ['[]', '{"Host":"evil"}', '{"Authorization":"line\\r\\n"}', '{invalid'])
		expect(parseTraceDestination('https://backend/v1/traces', headers)).toBeUndefined();
});

test('console tracing is opt-in, independent of OTLP, and respects the actual logger threshold', () => {
	const options = {
		tracingConsoleEnabled: false,
		tracingConsoleLevel: 'info',
		debug: false,
		tracingOtlpEndpoint: '',
		tracingOtlpHeaders: '',
	} as const;
	expect(resolveTraceOutputs(options)).toEqual({ consoleEnabled: false, destination: undefined });
	expect(resolveTraceOutputs({ ...options, tracingConsoleEnabled: true })).toEqual({
		consoleEnabled: true,
		destination: undefined,
	});
	expect(
		resolveTraceOutputs({ ...options, tracingConsoleEnabled: true, tracingConsoleLevel: 'debug' }).consoleEnabled,
	).toBe(false);
	expect(
		resolveTraceOutputs({ ...options, tracingConsoleEnabled: true, tracingConsoleLevel: 'debug', debug: true })
			.consoleEnabled,
	).toBe(true);
	expect(
		resolveTraceOutputs({ ...options, tracingOtlpEndpoint: 'https://backend/v1/traces' }).destination,
	).toBeDefined();
	expect(
		resolveTraceOutputs({ ...options, tracingConsoleEnabled: true, tracingOtlpEndpoint: 'bad' }).consoleEnabled,
	).toBe(true);
});
