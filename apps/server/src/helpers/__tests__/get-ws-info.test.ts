import { describe, expect, test } from 'bun:test';
import type http from 'node:http';
import { getWsInfo } from '../get-ws-info';

const makeReq = (headers: Record<string, string>, remoteAddress?: string): http.IncomingMessage =>
	({
		headers,
		socket: remoteAddress ? { remoteAddress } : undefined,
	}) as unknown as http.IncomingMessage;

const ipOf = (headers: Record<string, string>, opts?: { trustProxy?: boolean; remoteAddress?: string }) =>
	getWsInfo(undefined, makeReq(headers, opts?.remoteAddress), { trustProxy: opts?.trustProxy ?? true })?.ip;

describe('getWsInfo IP extraction', () => {
	test('takes the right-most x-forwarded-for entry (proxy-observed, not attacker-supplied)', () => {
		// Attacker sends "1.2.3.4"; the trusted proxy appends the real socket address.
		expect(ipOf({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' })).toBe('9.9.9.9');
	});

	test('does not return the left-most (spoofable) x-forwarded-for entry', () => {
		expect(ipOf({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' })).not.toBe('1.2.3.4');
	});

	test('filters empty segments before selecting the right-most entry', () => {
		expect(ipOf({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9, ' })).toBe('9.9.9.9');
		expect(ipOf({ 'x-forwarded-for': '1.2.3.4,,9.9.9.9' })).toBe('9.9.9.9');
	});

	test('returns undefined when every forwarded-for segment is empty', () => {
		expect(ipOf({ 'x-forwarded-for': ' , ' })).toBeUndefined();
	});

	test('handles a single x-forwarded-for value with no comma', () => {
		expect(ipOf({ 'x-forwarded-for': '9.9.9.9' })).toBe('9.9.9.9');
	});

	test('normalizes an IPv4-mapped IPv6 right-most entry', () => {
		expect(ipOf({ 'x-forwarded-for': '1.2.3.4, ::ffff:9.9.9.9' })).toBe('9.9.9.9');
	});

	test('ignores forwarding headers and uses the socket address when trustProxy is false', () => {
		expect(ipOf({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }, { trustProxy: false, remoteAddress: '10.0.0.5' })).toBe(
			'10.0.0.5',
		);
	});

	test('returns undefined ip when no source is available', () => {
		expect(ipOf({})).toBeUndefined();
	});
});
