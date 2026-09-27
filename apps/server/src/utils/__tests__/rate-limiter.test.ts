import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FixedWindowRateLimiter } from '../rate-limiters';

describe('FixedWindowRateLimiter', () => {
	let now = 1000;
	let originalNow: typeof performance.now;

	beforeEach(() => {
		now = 1000;
		originalNow = performance.now;
		performance.now = () => now;
	});

	afterEach(() => {
		performance.now = originalNow;
	});

	test('allows requests until max, then blocks', () => {
		const limiter = new FixedWindowRateLimiter({
			maxRequests: 3,
			windowMs: 10_000,
		});

		expect(limiter.consume('127.0.0.1')).toEqual({
			allowed: true,
			remaining: 2,
			retryAfterMs: 0,
		});

		expect(limiter.consume('127.0.0.1')).toEqual({
			allowed: true,
			remaining: 1,
			retryAfterMs: 0,
		});

		expect(limiter.consume('127.0.0.1')).toEqual({
			allowed: true,
			remaining: 0,
			retryAfterMs: 0,
		});

		const blocked = limiter.consume('127.0.0.1');

		expect(blocked.allowed).toBe(false);
		expect(blocked.remaining).toBe(0);
		expect(blocked.retryAfterMs).toBe(10_000);
	});

	test('resets counter after the time window expires', () => {
		const limiter = new FixedWindowRateLimiter({
			maxRequests: 1,
			windowMs: 5_000,
		});

		expect(limiter.consume('1.2.3.4').allowed).toBe(true);
		expect(limiter.consume('1.2.3.4').allowed).toBe(false);

		now += 5_000;

		const afterReset = limiter.consume('1.2.3.4');

		expect(afterReset).toEqual({
			allowed: true,
			remaining: 0,
			retryAfterMs: 0,
		});
	});

	test('tracks limits independently per key', () => {
		const limiter = new FixedWindowRateLimiter({
			maxRequests: 1,
			windowMs: 60_000,
		});

		expect(limiter.consume('ip-a').allowed).toBe(true);
		expect(limiter.consume('ip-a').allowed).toBe(false);
		expect(limiter.consume('ip-b').allowed).toBe(true);
	});

	test('clear removes all tracked keys', () => {
		const limiter = new FixedWindowRateLimiter({
			maxRequests: 1,
			windowMs: 60_000,
		});

		limiter.consume('ip-a');
		expect(limiter.consume('ip-a').allowed).toBe(false);

		limiter.clear();

		expect(limiter.consume('ip-a')).toEqual({
			allowed: true,
			remaining: 0,
			retryAfterMs: 0,
		});
	});

	test('saturated request-key storage admits new keys without resetting the current key', () => {
		const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000, maxEntries: 2 });
		limiter.consume('oldest');
		limiter.consume('other');
		expect(limiter.consume('oldest').allowed).toBe(false);
		expect(limiter.consume('new-address').allowed).toBe(true);
		expect(limiter.consume('other').allowed).toBe(false);
	});

	test('renewing an expired key moves it behind older active windows before eviction', () => {
		const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 100, maxEntries: 3 });
		limiter.consume('renewed');
		now += 10;
		limiter.consume('older-active');
		now += 90;
		limiter.consume('renewed');
		limiter.consume('third');
		limiter.consume('new');
		expect(limiter.consume('renewed').allowed).toBe(false);
		expect(limiter.consume('third').allowed).toBe(false);
		expect(limiter.consume('older-active').allowed).toBe(true);
	});

	test('wall-clock corrections do not change active budgets or expiry order', () => {
		const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 100, maxEntries: 2 });
		limiter.consume('active');
		const originalWallClock = Date.now;
		try {
			Date.now = () => -1_000_000;
			now += 10;
			limiter.consume('newer');
			expect(limiter.consume('active').allowed).toBe(false);
			Date.now = () => 1_000_000;
			expect(limiter.consume('newer').allowed).toBe(false);
			now += 90;
			expect(limiter.consume('replacement').allowed).toBe(true);
			expect(limiter.consume('newer').allowed).toBe(false);
		} finally {
			Date.now = originalWallClock;
		}
	});

	test('capacity cleanup reclaims expired windows before evicting active ones', () => {
		const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 100, maxEntries: 3 });
		limiter.consume('expired-one');
		limiter.consume('expired-two');
		now += 10;
		limiter.consume('active');
		now += 90;
		expect(limiter.consume('new-one').allowed).toBe(true);
		expect(limiter.consume('new-two').allowed).toBe(true);
		expect(limiter.consume('active').allowed).toBe(false);
	});

	test('account budgets survive more than 10000 other accounts and admit new accounts', () => {
		const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000, retainActiveEntries: true });
		limiter.consume('target');
		for (let index = 0; index < 10001; index += 1) {
			expect(limiter.consume(`user:${index}`).allowed).toBe(true);
		}
		expect(limiter.consume('target').allowed).toBe(false);
		limiter.clear();
	});

	test('retained account budgets expire and clear cannot delete a replacement budget', async () => {
		performance.now = originalNow;
		const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 40, retainActiveEntries: true });
		limiter.consume('account');
		await Bun.sleep(25);
		limiter.clear();
		limiter.consume('account');
		await Bun.sleep(25);
		expect(limiter.consume('account').allowed).toBe(false);
		await Bun.sleep(25);
		expect(limiter.consume('account').allowed).toBe(true);
		limiter.clear();
	});

	test('an expired existing key starts a fresh window at capacity', () => {
		const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 5000, maxEntries: 2 });
		limiter.consume('old');
		now += 1000;
		limiter.consume('later');
		now += 4000;
		expect(limiter.consume('old').allowed).toBe(true);
		expect(limiter.consume('old').allowed).toBe(false);
		expect(limiter.consume('later').allowed).toBe(false);
	});
});
