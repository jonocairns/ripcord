import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FixedWindowRateLimiter } from '../rate-limiters';

describe('FixedWindowRateLimiter', () => {
	let now = 1000;
	let originalDateNow: typeof Date.now;

	beforeEach(() => {
		now = 1000;
		originalDateNow = Date.now;
		Date.now = () => now;
	});

	afterEach(() => {
		Date.now = originalDateNow;
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

	test('preserves active budgets at capacity despite repeated new keys', () => {
		const limiter = new FixedWindowRateLimiter({ maxRequests: 2, windowMs: 60_000, maxEntries: 2 });
		limiter.consume('target');
		limiter.consume('target');
		now += 1000;
		limiter.consume('legitimate');

		for (let index = 0; index < 10; index += 1) {
			expect(limiter.consume(`churn-${index}`)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 59_000 });
			expect(limiter.consume('target').allowed).toBe(false);
		}
		expect(limiter.consume('legitimate').allowed).toBe(true);
		expect(limiter.consume('legitimate').allowed).toBe(false);

		now += 59_000;
		expect(limiter.consume('new-key').allowed).toBe(true);
		expect(limiter.consume('legitimate')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 1000 });
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
