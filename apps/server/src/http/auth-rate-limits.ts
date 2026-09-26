import { createRateLimiter } from '../utils/rate-limiters/rate-limiter';
import { HttpRateLimitError } from './utils';

// Second layer behind the per-IP limiter on /login and /verify-2fa, keyed by
// the account being attacked so rotating source addresses does not reset the
// budget. The window is deliberately generous: anyone who knows an identity can
// spend it and lock that account out of password sign-in for up to 15 minutes,
// so it only has to make online guessing slow, not fail fast.
const AUTH_ACCOUNT_MAX_ATTEMPTS = 10;
const AUTH_ACCOUNT_WINDOW_MS = 15 * 60_000;

const loginAccountRateLimiter = createRateLimiter({
	maxRequests: AUTH_ACCOUNT_MAX_ATTEMPTS,
	windowMs: AUTH_ACCOUNT_WINDOW_MS,
	// Cardinality is bounded by persisted accounts; expiry removes idle budgets.
	retainActiveEntries: true,
});

const twoFactorUserRateLimiter = createRateLimiter({
	maxRequests: AUTH_ACCOUNT_MAX_ATTEMPTS,
	windowMs: AUTH_ACCOUNT_WINDOW_MS,
	// Cardinality is bounded by persisted accounts; expiry removes idle budgets.
	retainActiveEntries: true,
});

const consumeLoginAccountAttempt = (userId: number) => {
	const rateLimit = loginAccountRateLimiter.consume(`user:${userId}`);

	if (!rateLimit.allowed) {
		throw new HttpRateLimitError(
			'Too many login attempts for this account. Please try again later.',
			rateLimit.retryAfterMs,
		);
	}
};

const consumeTwoFactorAttempt = (userId: number) => {
	const rateLimit = twoFactorUserRateLimiter.consume(`user:${userId}`);

	if (!rateLimit.allowed) {
		throw new HttpRateLimitError(
			'Too many verification attempts for this account. Please try again later.',
			rateLimit.retryAfterMs,
		);
	}
};

export { AUTH_ACCOUNT_MAX_ATTEMPTS, consumeLoginAccountAttempt, consumeTwoFactorAttempt };
