import { expect, test } from 'bun:test';
import { parseTraceDestination } from './trace-config';

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
