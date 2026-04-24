import { describe, expect, it } from 'bun:test';
import { normalizeServerUrl } from '../server-config';

describe('normalizeServerUrl', () => {
	it('adds http scheme when protocol is missing', () => {
		const normalized = normalizeServerUrl('localhost:4991');

		expect(normalized.url).toBe('http://localhost:4991');
		expect(normalized.host).toBe('localhost:4991');
	});

	it('keeps https URLs normalized without path/query', () => {
		const normalized = normalizeServerUrl('https://demo.sharkord.com/connect?foo=bar');

		expect(normalized.url).toBe('https://demo.sharkord.com');
		expect(normalized.host).toBe('demo.sharkord.com');
	});

	it('accepts bracketed IPv6 hosts', () => {
		const normalized = normalizeServerUrl('http://[2001:db8::10]:4991/connect');

		expect(normalized.url).toBe('http://[2001:db8::10]:4991');
		expect(normalized.host).toBe('[2001:db8::10]:4991');
	});

	it('adds http scheme for bracketed IPv6 hosts without a protocol', () => {
		const normalized = normalizeServerUrl('[::1]:4991');

		expect(normalized.url).toBe('http://[::1]:4991');
		expect(normalized.host).toBe('[::1]:4991');
	});

	it('rejects unsupported protocols', () => {
		expect(() => normalizeServerUrl('ftp://localhost:4991')).toThrow('Only HTTP/HTTPS server URLs are supported.');
	});
});
