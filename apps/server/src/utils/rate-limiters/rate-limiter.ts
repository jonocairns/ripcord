import { FixedWindowRateLimiter } from '.';
import { AsyncLocalStorage } from 'node:async_hooks';

const trackedRateLimiters = new Set<FixedWindowRateLimiter>();
const testRateLimiterScopeStorage = new AsyncLocalStorage<string>();

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
  const scope = testRateLimiterScopeStorage.getStore();

  return scope ? `${scope}:${baseKey}` : baseKey;
};

const clearRateLimitersForTests = () => {
  for (const limiter of trackedRateLimiters) {
    limiter.clear();
  }
};

const setRateLimiterScopeForTests = (scope: string) => {
  testRateLimiterScopeStorage.enterWith(scope);
};

export {
  clearRateLimitersForTests,
  createRateLimiter,
  FixedWindowRateLimiter,
  getClientRateLimitKey,
  getRateLimitRetrySeconds,
  setRateLimiterScopeForTests
};
