const IP_CACHE_TTL = 1000 * 60 * 60; // 1 hour

class IpInfoCache {
  private cache = new Map<string, unknown>();
  private timers = new Map<string, NodeJS.Timeout>();

  get<T = unknown>(ip: string): T | undefined {
    return this.cache.get(ip) as T | undefined;
  }

  set(ip: string, data: unknown) {
    this.cache.set(ip, data);

    // Cancel any pending eviction so a new write extends the TTL instead of
    // letting the earlier timer expire the fresh entry early.
    const existingTimer = this.timers.get(ip);

    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.timers.set(
      ip,
      setTimeout(() => {
        this.cache.delete(ip);
        this.timers.delete(ip);
      }, IP_CACHE_TTL)
    );
  }
}

const ipCache = new IpInfoCache();

export { ipCache };
