import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { tdb, testsBaseUrl } from '../../__tests__/setup';
import { settings, users } from '../../db/schema';
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
				{ identity: 'testowner', password: 'wrongpassword' },
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

	test('case and whitespace distinct accounts retain independent login budgets', async () => {
		setClientIpOptionsForTests({ trustProxy: true });
		const owner = await tdb.select().from(users).where(eq(users.id, 1)).get();
		expect(owner).toBeDefined();
		if (!owner) throw new Error('Missing seeded owner');
		for (const identity of ['TestOwner', ' testowner']) {
			await tdb.insert(users).values({ identity, name: identity, password: owner.password, createdAt: Date.now() });
		}
		for (let index = 0; index < AUTH_ACCOUNT_MAX_ATTEMPTS; index += 1) {
			await postJson(
				'/login',
				{ identity: 'testowner', password: 'wrongpassword' },
				{ 'x-forwarded-for': spoofedIp(index) },
			);
		}
		const blocked = await postJson(
			'/login',
			{ identity: 'testowner', password: 'password123' },
			{ 'x-forwarded-for': spoofedIp(20) },
		);
		expect(blocked.status).toBe(429);
		for (const [index, identity] of ['TestOwner', ' testowner'].entries()) {
			const response = await postJson(
				'/login',
				{ identity, password: 'password123' },
				{ 'x-forwarded-for': spoofedIp(21 + index) },
			);
			expect(response.status).toBe(200);
		}
	});

	test('invalid identities cannot accumulate account budgets when registration is closed', async () => {
		setClientIpOptionsForTests({ trustProxy: true });
		await tdb.update(settings).set({ allowNewUsers: false });
		for (let index = 0; index <= AUTH_ACCOUNT_MAX_ATTEMPTS; index += 1) {
			const response = await postJson(
				'/login',
				{ identity: 'nonexistent', password: 'wrongpassword' },
				{ 'x-forwarded-for': spoofedIp(index) },
			);
			expect(response.status).toBe(400);
		}
		const valid = await postJson(
			'/login',
			{ identity: 'testowner', password: 'password123' },
			{ 'x-forwarded-for': spoofedIp(30) },
		);
		expect(valid.status).toBe(200);
	});

	test('saturated IP storage still admits a new login and does not reset the account budget', async () => {
		setClientIpOptionsForTests({ trustProxy: true });
		for (let index = 0; index < AUTH_ACCOUNT_MAX_ATTEMPTS; index += 1) {
			await postJson(
				'/login',
				{ identity: 'testowner', password: 'wrongpassword' },
				{ 'x-forwarded-for': spoofedIp(index) },
			);
		}
		// Invalid bodies still consume the IP budget, without creating accounts.
		for (let start = 0; start < 10001; start += 50) {
			await Promise.all(
				Array.from({ length: Math.min(50, 10001 - start) }, (_, offset) =>
					postJson('/login', {}, { 'x-forwarded-for': `2001:db8::${(start + offset + 1).toString(16)}` }),
				),
			);
		}
		const blocked = await postJson(
			'/login',
			{ identity: 'testowner', password: 'password123' },
			{ 'x-forwarded-for': '198.51.100.10' },
		);
		expect(blocked.status).toBe(429);
		expect(await blocked.json()).toEqual({
			error: 'Too many login attempts for this account. Please try again later.',
		});
		const valid = await postJson(
			'/login',
			{ identity: 'testuser', password: 'password123' },
			{ 'x-forwarded-for': '198.51.100.11' },
		);
		expect(valid.status).toBe(200);
	}, 30000);

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
