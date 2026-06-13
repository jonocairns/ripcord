import { describe, expect, it } from 'bun:test';
import { isPrivateServerHostname, normalizeServerUrl } from '../server-config';

describe('normalizeServerUrl', () => {
	it('defaults to http for schemeless localhost', () => {
		const normalized = normalizeServerUrl('localhost:4991');

		expect(normalized.url).toBe('http://localhost:4991');
		expect(normalized.host).toBe('localhost:4991');
	});

	it('defaults to https for schemeless public hostnames', () => {
		const normalized = normalizeServerUrl('demo.sharkord.com');

		expect(normalized.url).toBe('https://demo.sharkord.com');
		expect(normalized.host).toBe('demo.sharkord.com');
	});

	it('defaults to http for schemeless private addresses', () => {
		expect(normalizeServerUrl('192.168.1.50:4991').url).toBe('http://192.168.1.50:4991');
		expect(normalizeServerUrl('10.0.0.5').url).toBe('http://10.0.0.5');
		expect(normalizeServerUrl('172.20.0.5:4991').url).toBe('http://172.20.0.5:4991');
		expect(normalizeServerUrl('myserver:4991').url).toBe('http://myserver:4991');
		expect(normalizeServerUrl('ripcord.local').url).toBe('http://ripcord.local');
	});

	it('keeps an explicit http scheme even for public hostnames', () => {
		const normalized = normalizeServerUrl('http://demo.sharkord.com');

		expect(normalized.url).toBe('http://demo.sharkord.com');
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

	it('adds http scheme for bracketed loopback IPv6 hosts without a protocol', () => {
		const normalized = normalizeServerUrl('[::1]:4991');

		expect(normalized.url).toBe('http://[::1]:4991');
		expect(normalized.host).toBe('[::1]:4991');
	});

	it('adds https scheme for bracketed public IPv6 hosts without a protocol', () => {
		const normalized = normalizeServerUrl('[2001:db8::10]:4991');

		expect(normalized.url).toBe('https://[2001:db8::10]:4991');
		expect(normalized.host).toBe('[2001:db8::10]:4991');
	});

	it('rejects unsupported protocols', () => {
		expect(() => normalizeServerUrl('ftp://localhost:4991')).toThrow('Only HTTP/HTTPS server URLs are supported.');
	});
});

describe('isPrivateServerHostname', () => {
	it('treats loopback, RFC 1918, link-local, and mDNS hosts as private', () => {
		expect(isPrivateServerHostname('localhost')).toBe(true);
		expect(isPrivateServerHostname('app.localhost')).toBe(true);
		expect(isPrivateServerHostname('127.0.0.1')).toBe(true);
		expect(isPrivateServerHostname('10.1.2.3')).toBe(true);
		expect(isPrivateServerHostname('172.16.0.1')).toBe(true);
		expect(isPrivateServerHostname('172.31.255.1')).toBe(true);
		expect(isPrivateServerHostname('192.168.0.1')).toBe(true);
		expect(isPrivateServerHostname('169.254.10.10')).toBe(true);
		expect(isPrivateServerHostname('ripcord.local')).toBe(true);
		expect(isPrivateServerHostname('myserver')).toBe(true);
		expect(isPrivateServerHostname('[::1]')).toBe(true);
		expect(isPrivateServerHostname('[fd00::1]')).toBe(true);
		expect(isPrivateServerHostname('[fe80::1]')).toBe(true);
		expect(isPrivateServerHostname('[febf::1]')).toBe(true);
	});

	it('treats public hosts as public', () => {
		expect(isPrivateServerHostname('demo.sharkord.com')).toBe(false);
		expect(isPrivateServerHostname('ysw.tycho.nz')).toBe(false);
		expect(isPrivateServerHostname('172.32.0.1')).toBe(false);
		expect(isPrivateServerHostname('8.8.8.8')).toBe(false);
		expect(isPrivateServerHostname('[2001:db8::10]')).toBe(false);
		expect(isPrivateServerHostname('[fe8::1]')).toBe(false);
		expect(isPrivateServerHostname('[fec0::1]')).toBe(false);
	});
});
