import { describe, expect, test } from 'bun:test';
import { testsBaseUrl } from '../../__tests__/setup';
import { setClientIpOptionsForTests } from '../../helpers/client-ip-options';
import { createChallengeToken } from '../../helpers/totp';
import { AUTH_ACCOUNT_MAX_ATTEMPTS } from '../auth-rate-limits';

const IP_LIMIT_MESSAGE = 'Too many login attempts. Please try again shortly.';

const postJson = (path: string, body: unknown, headers: Record<string, string>) =>
	fetch(`${testsBaseUrl}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});

const spoofedIp = (index: number) => `203.0.113.${index + 1}`;

describe('auth rate limits', () => {
	test('rotating spoofed forwarding headers from an untrusted peer does not escape the IP limiter', async () => {
		// Tests connect from loopback; trusting only another address makes the
		// test client an untrusted peer, like an attacker reaching the port directly.
		setClientIpOptionsForTests({ trustProxy: true, trustedProxies: '10.0.0.2' });

		for (let index = 0; index < 5; index += 1) {
			const response = await postJson(
				'/login',
				{ identity: 'testowner', password: 'wrongpassword' },
				{ 'x-forwarded-for': spoofedIp(index), 'cf-connecting-ip': spoofedIp(index), 'x-real-ip': spoofedIp(index) },
			);

			expect(response.status).toBe(400);
		}

		const limited = await postJson(
			'/login',
			{ identity: 'testowner', password: 'wrongpassword' },
			{ 'x-forwarded-for': spoofedIp(99), 'cf-connecting-ip': spoofedIp(99) },
		);

		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({ error: IP_LIMIT_MESSAGE });
	});

	test('the per-identity login limiter trips across different client IPs', async () => {
		// Loopback is a trusted proxy by default, so each request gets its own IP.
		setClientIpOptionsForTests({ trustProxy: true, trustedProxies: '' });

		for (let index = 0; index < AUTH_ACCOUNT_MAX_ATTEMPTS; index += 1) {
			const response = await postJson(
				'/login',
				{ identity: index % 2 === 0 ? 'testowner' : ' TestOwner', password: 'wrongpassword' },
				{ 'x-forwarded-for': spoofedIp(index) },
			);

			expect(response.status).not.toBe(429);
		}

		const limited = await postJson(
			'/login',
			{ identity: 'testowner', password: 'password123' },
			{ 'x-forwarded-for': spoofedIp(AUTH_ACCOUNT_MAX_ATTEMPTS) },
		);

		expect(limited.status).toBe(429);
		expect(limited.headers.get('retry-after')).toBeTruthy();
		expect(await limited.json()).toEqual({
			error: 'Too many login attempts for this account. Please try again later.',
		});

		const otherAccount = await postJson(
			'/login',
			{ identity: 'testuser', password: 'password123' },
			{ 'x-forwarded-for': spoofedIp(AUTH_ACCOUNT_MAX_ATTEMPTS + 1) },
		);

		expect(otherAccount.status).toBe(200);
	});

	test('the per-user 2FA limiter trips across different client IPs', async () => {
		setClientIpOptionsForTests({ trustProxy: true, trustedProxies: '' });

		const challengeToken = await createChallengeToken(1);

		for (let index = 0; index < AUTH_ACCOUNT_MAX_ATTEMPTS; index += 1) {
			const response = await postJson(
				'/verify-2fa',
				{ challengeToken, code: '000000' },
				{ 'x-forwarded-for': spoofedIp(index) },
			);

			expect(response.status).toBe(400);
		}

		const limited = await postJson(
			'/verify-2fa',
			{ challengeToken: await createChallengeToken(1), code: '000000' },
			{ 'x-forwarded-for': spoofedIp(AUTH_ACCOUNT_MAX_ATTEMPTS) },
		);

		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({
			error: 'Too many verification attempts for this account. Please try again later.',
		});
	});
});
