import { describe, expect, test } from 'bun:test';
import type http from 'node:http';
import { getWsInfo, type TClientIpOptions } from '../get-ws-info';

const makeReq = (headers: Record<string, string>, remoteAddress?: string): http.IncomingMessage =>
	({
		headers,
		socket: remoteAddress ? { remoteAddress } : undefined,
	}) as unknown as http.IncomingMessage;

const LOCAL_PROXY = '127.0.0.1';
const DOCKER_GATEWAY = '172.17.0.1';
const PUBLIC_PEER = '198.51.100.7';

const ipOf = (headers: Record<string, string>, remoteAddress: string | undefined, options?: TClientIpOptions) =>
	getWsInfo(undefined, makeReq(headers, remoteAddress), { trustProxy: true, ...options })?.ip;

describe('getWsInfo IP extraction', () => {
	describe('untrusted peer', () => {
		test('ignores every forwarding header from a public peer', () => {
			const spoofed = {
				'cf-connecting-ip': '1.1.1.1',
				'x-real-ip': '2.2.2.2',
				'x-forwarded-for': '3.3.3.3',
			};

			expect(ipOf(spoofed, PUBLIC_PEER)).toBe(PUBLIC_PEER);
		});

		test('ignores a configured client IP header from an untrusted peer', () => {
			expect(ipOf({ 'cf-connecting-ip': '1.1.1.1' }, PUBLIC_PEER, { clientIpHeader: 'cf-connecting-ip' })).toBe(
				PUBLIC_PEER,
			);
		});

		test('ignores headers from a private peer outside an explicit trusted list', () => {
			expect(ipOf({ 'x-forwarded-for': '3.3.3.3' }, DOCKER_GATEWAY, { trustedProxies: '10.0.0.2' })).toBe(
				DOCKER_GATEWAY,
			);
		});

		test('ignores forwarding headers and uses the socket address when trustProxy is false', () => {
			expect(ipOf({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }, '10.0.0.5', { trustProxy: false })).toBe('10.0.0.5');
		});

		test('returns undefined ip when there is no peer address', () => {
			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, undefined)).toBeUndefined();
		});
	});

	describe('trusted peer', () => {
		test('trusts loopback and Docker bridge peers by default', () => {
			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, LOCAL_PROXY)).toBe('9.9.9.9');
			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, DOCKER_GATEWAY)).toBe('9.9.9.9');
			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, '::ffff:172.17.0.1')).toBe('9.9.9.9');
		});

		test('honours an explicit trusted proxy list with CIDRs and bare addresses', () => {
			const options = { trustedProxies: '203.0.113.0/24, 2001:db8::10' };

			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, '203.0.113.40', options)).toBe('9.9.9.9');
			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, '2001:db8::10', options)).toBe('9.9.9.9');
			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, LOCAL_PROXY, options)).toBe(LOCAL_PROXY);
		});

		test('matches IPv4-mapped proxy CIDRs against mapped and IPv4 peers', () => {
			const options = { trustedProxies: '::ffff:172.17.0.0/120' };
			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, '::ffff:172.17.0.1', options)).toBe('9.9.9.9');
			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, '172.17.0.1', options)).toBe('9.9.9.9');
			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, '172.17.1.1', options)).toBe('172.17.1.1');
		});

		test('rejects mapped CIDRs broader than the IPv4 mapping', () => {
			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, DOCKER_GATEWAY, { trustedProxies: '::ffff:0:0/80' })).toBe(
				DOCKER_GATEWAY,
			);
		});

		test('skips invalid trusted proxy entries without trusting everything', () => {
			expect(ipOf({ 'x-forwarded-for': '9.9.9.9' }, PUBLIC_PEER, { trustedProxies: 'not-an-ip, 10.0.0.0/99' })).toBe(
				PUBLIC_PEER,
			);
		});

		test('prefers x-forwarded-for over a client-supplied cf-connecting-ip', () => {
			expect(ipOf({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '9.9.9.9' }, LOCAL_PROXY)).toBe('9.9.9.9');
		});

		test('ignores cf-connecting-ip unless it is the configured header', () => {
			expect(ipOf({ 'cf-connecting-ip': '1.1.1.1' }, LOCAL_PROXY)).toBe(LOCAL_PROXY);
			expect(ipOf({ 'cf-connecting-ip': '1.1.1.1' }, LOCAL_PROXY, { clientIpHeader: 'CF-Connecting-IP' })).toBe(
				'1.1.1.1',
			);
		});

		test('falls back to the peer when the configured header is missing or invalid', () => {
			expect(ipOf({}, LOCAL_PROXY, { clientIpHeader: 'cf-connecting-ip' })).toBe(LOCAL_PROXY);
			expect(ipOf({ 'cf-connecting-ip': 'garbage' }, LOCAL_PROXY, { clientIpHeader: 'cf-connecting-ip' })).toBe(
				LOCAL_PROXY,
			);
		});

		test('uses x-real-ip only when x-forwarded-for is absent', () => {
			expect(ipOf({ 'x-real-ip': '2.2.2.2' }, LOCAL_PROXY)).toBe('2.2.2.2');
			expect(ipOf({ 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '9.9.9.9' }, LOCAL_PROXY)).toBe('9.9.9.9');
		});
	});

	describe('multi-hop x-forwarded-for', () => {
		test('takes the right-most entry appended by a single trusted proxy', () => {
			// Attacker sends "1.2.3.4"; the trusted proxy appends the real socket address.
			expect(ipOf({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }, LOCAL_PROXY)).toBe('9.9.9.9');
		});

		test('skips trusted hops right to left until the first untrusted address', () => {
			// client -> cloudflared (10.0.0.3) -> nginx (loopback) -> ripcord
			expect(ipOf({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9, 10.0.0.3' }, LOCAL_PROXY)).toBe('9.9.9.9');
		});

		test('stops at an unparseable hop instead of returning attacker text', () => {
			expect(ipOf({ 'x-forwarded-for': 'evil, 10.0.0.3' }, LOCAL_PROXY)).toBe('10.0.0.3');
		});

		test('filters empty segments before walking', () => {
			expect(ipOf({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9, ' }, LOCAL_PROXY)).toBe('9.9.9.9');
			expect(ipOf({ 'x-forwarded-for': '1.2.3.4,,9.9.9.9' }, LOCAL_PROXY)).toBe('9.9.9.9');
		});

		test('falls back to the peer when every forwarded-for segment is empty', () => {
			expect(ipOf({ 'x-forwarded-for': ' , ' }, LOCAL_PROXY)).toBe(LOCAL_PROXY);
		});

		test('normalizes IPv4-mapped IPv6 entries', () => {
			expect(ipOf({ 'x-forwarded-for': '1.2.3.4, ::ffff:9.9.9.9' }, LOCAL_PROXY)).toBe('9.9.9.9');
		});

		test('handles IPv6 clients and bracketed literals', () => {
			expect(ipOf({ 'x-forwarded-for': '[2001:db8::1]' }, '::1')).toBe('2001:db8::1');
		});
	});
});
