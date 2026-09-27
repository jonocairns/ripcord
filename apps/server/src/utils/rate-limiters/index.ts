type TFixedWindowRateLimiterOptions = {
	maxRequests: number;
	windowMs: number;
	maxEntries?: number;
	// Only for keys drawn from persisted accounts, never arbitrary request input.
	retainActiveEntries?: boolean;
};

type TRateLimitResult = {
	allowed: boolean;
	remaining: number;
	retryAfterMs: number;
};

type TRateLimitEntry = {
	count: number;
	resetAt: number;
	cleanupTimer?: ReturnType<typeof setTimeout>;
};

// this is a pretty basic implementation of a fixed window rate limiter, but for now it's better than nothing
class FixedWindowRateLimiter {
	private readonly entries = new Map<string, TRateLimitEntry>();
	private readonly maxRequests: number;
	private readonly windowMs: number;
	private readonly maxEntries: number;
	private readonly retainActiveEntries: boolean;

	constructor({
		maxRequests,
		windowMs,
		maxEntries = 10_000, // default to 10k entries
		retainActiveEntries = false,
	}: TFixedWindowRateLimiterOptions) {
		this.maxRequests = maxRequests;
		this.windowMs = windowMs;
		this.maxEntries = maxEntries;
		this.retainActiveEntries = retainActiveEntries;
	}

	public consume = (key: string): TRateLimitResult => {
		// Monotonic time keeps insertion and expiry order aligned across clock corrections.
		const now = performance.now();

		const existing = this.entries.get(key);

		if (!existing || existing.resetAt <= now) {
			if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer);
			// A renewed window belongs at the end of the expiry-ordered map.
			if (existing) this.entries.delete(key);
			if (!this.retainActiveEntries) this.makeRoom(now);

			const entry: TRateLimitEntry = { count: 1, resetAt: now + this.windowMs };
			if (this.retainActiveEntries) {
				entry.cleanupTimer = setTimeout(() => {
					if (this.entries.get(key) === entry) this.entries.delete(key);
				}, this.windowMs).unref();
			}
			this.entries.set(key, entry);

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
		for (const entry of this.entries.values()) {
			if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
		}
		this.entries.clear();
	};

	// Request-controlled keys use best-effort budgets: saturation must not deny
	// every new address. Existing keys are checked before this eviction path.
	private makeRoom = (now: number): void => {
		if (this.entries.size < this.maxEntries) return;
		for (const [key, value] of this.entries) {
			if (value.resetAt > now) break;
			this.entries.delete(key);
		}
		if (this.entries.size >= this.maxEntries) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey !== undefined) this.entries.delete(oldestKey);
		}
	};
}

export type { TRateLimitResult };
export { FixedWindowRateLimiter };
