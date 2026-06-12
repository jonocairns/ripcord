import { describe, expect, test } from 'bun:test';
import { isUrlSafeForPreview } from '../get-message-metadata';

// isUrlSafeForPreview is the per-hop guard reused for both the first-hop URL and
// every redirect target (via handleRedirects). It blocks non-http(s) protocols and
// literal private/loopback/link-local IPs; DNS-based private-IP rejection is handled
// separately by resolveDNSHost and is not exercised here.
describe('isUrlSafeForPreview', () => {
	test('allows public http(s) URLs', () => {
		expect(isUrlSafeForPreview('https://example.com/page')).toBe(true);
		expect(isUrlSafeForPreview('http://example.com')).toBe(true);
		expect(isUrlSafeForPreview('https://1.1.1.1/')).toBe(true);
		expect(isUrlSafeForPreview('http://[2606:4700:4700::1111]/')).toBe(true);
	});

	test('blocks non-http(s) protocols', () => {
		expect(isUrlSafeForPreview('file:///etc/passwd')).toBe(false);
		expect(isUrlSafeForPreview('ftp://example.com')).toBe(false);
		expect(isUrlSafeForPreview('gopher://example.com')).toBe(false);
		expect(isUrlSafeForPreview('data:text/html,hi')).toBe(false);
	});

	test('blocks literal loopback addresses', () => {
		expect(isUrlSafeForPreview('http://127.0.0.1/')).toBe(false);
		expect(isUrlSafeForPreview('http://127.0.0.1:8080/admin')).toBe(false);
		expect(isUrlSafeForPreview('http://[::1]/')).toBe(false);
	});

	test('blocks literal link-local addresses (cloud metadata)', () => {
		expect(isUrlSafeForPreview('http://169.254.169.254/latest/meta-data/')).toBe(false);
		expect(isUrlSafeForPreview('http://[fe80::1]/')).toBe(false);
	});

	test('blocks literal private-range addresses', () => {
		expect(isUrlSafeForPreview('http://10.0.0.5/')).toBe(false);
		expect(isUrlSafeForPreview('http://192.168.1.1/')).toBe(false);
		expect(isUrlSafeForPreview('http://172.16.0.1/')).toBe(false);
		expect(isUrlSafeForPreview('http://[fc00::1]/')).toBe(false);
	});

	test('blocks unparseable input', () => {
		expect(isUrlSafeForPreview('not a url')).toBe(false);
		expect(isUrlSafeForPreview('')).toBe(false);
	});

	// The handleRedirects callback is a thin wrapper that applies the same guard to
	// the forwarded URL, so a 3xx Location pointing at an internal target is rejected.
	test('redirect guard rejects a Location pointing at an internal target', () => {
		const handleRedirects = (_baseURL: string, forwardedURL: string) => isUrlSafeForPreview(forwardedURL);

		expect(handleRedirects('https://example.com', 'http://169.254.169.254/latest/meta-data/')).toBe(false);
		expect(handleRedirects('https://example.com', 'http://127.0.0.1/')).toBe(false);
		expect(handleRedirects('https://example.com', 'https://other-public.example/ok')).toBe(true);
	});
});
