type TFixedWindowRateLimiterOptions = {
	maxRequests: number;
	windowMs: number;
	maxEntries?: number;
};

type TRateLimitResult = {
	allowed: boolean;
	remaining: number;
	retryAfterMs: number;
};

type TRateLimitEntry = {
	count: number;
	resetAt: number;
};

// this is a pretty basic implementation of a fixed window rate limiter, but for now it's better than nothing
class FixedWindowRateLimiter {
	private readonly entries = new Map<string, TRateLimitEntry>();
	private readonly maxRequests: number;
	private readonly windowMs: number;
	private readonly maxEntries: number;

	constructor({
		maxRequests,
		windowMs,
		maxEntries = 10_000, // default to 10k entries
	}: TFixedWindowRateLimiterOptions) {
		this.maxRequests = maxRequests;
		this.windowMs = windowMs;
		this.maxEntries = maxEntries;
	}

	public consume = (key: string): TRateLimitResult => {
		const now = Date.now();

		const existing = this.entries.get(key);

		if (!existing || existing.resetAt <= now) {
			const retryAfterMs = this.makeRoom(now);
			if (retryAfterMs > 0) {
				return { allowed: false, remaining: 0, retryAfterMs };
			}

			this.entries.set(key, {
				count: 1,
				resetAt: now + this.windowMs,
			});

			return {
				allowed: true,
				remaining: this.maxRequests - 1,
				retryAfterMs: 0,
			};
		}

		if (existing.count >= this.maxRequests) {
			return {
				allowed: false,
				remaining: 0,
				retryAfterMs: existing.resetAt - now,
			};
		}

		existing.count += 1;

		return {
			allowed: true,
			remaining: this.maxRequests - existing.count,
			retryAfterMs: 0,
		};
	};

	public clear = () => {
		this.entries.clear();
	};

	// Expired budgets may be reclaimed; active budgets must survive key churn.
	// When full, reject new keys until the earliest existing window expires.
	private makeRoom = (now: number): number => {
		if (this.entries.size < this.maxEntries) return 0;

		let earliestResetAt = Number.POSITIVE_INFINITY;
		for (const [key, value] of this.entries) {
			if (value.resetAt <= now) {
				this.entries.delete(key);
			} else {
				earliestResetAt = Math.min(earliestResetAt, value.resetAt);
			}
		}

		return this.entries.size < this.maxEntries ? 0 : earliestResetAt - now;
	};
}

export type { TRateLimitResult };
export { FixedWindowRateLimiter };
