import { FixedWindowRateLimiter } from '.';

const trackedRateLimiters = new Set<FixedWindowRateLimiter>();
let testRateLimiterScope: string | undefined;

const createRateLimiter = (
  options: ConstructorParameters<typeof FixedWindowRateLimiter>[0]
) => {
  const limiter = new FixedWindowRateLimiter(options);

  trackedRateLimiters.add(limiter);

  return limiter;
};

const getRateLimitRetrySeconds = (retryAfterMs: number): number => {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
};

const getClientRateLimitKey = (input?: string): string => {
  const baseKey = input && input.trim().length > 0 ? input.trim() : 'unknown';

  return testRateLimiterScope ? `${testRateLimiterScope}:${baseKey}` : baseKey;
};

const clearRateLimitersForTests = () => {
  for (const limiter of trackedRateLimiters) {
    limiter.clear();
  }

  testRateLimiterScope = undefined;
};

const setRateLimiterScopeForTests = (scope: string) => {
  testRateLimiterScope = scope;
};

export {
  clearRateLimitersForTests,
  createRateLimiter,
  FixedWindowRateLimiter,
  getClientRateLimitKey,
  getRateLimitRetrySeconds,
  setRateLimiterScopeForTests
};
