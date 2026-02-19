const IP_CACHE_TTL = 1000 * 60 * 60; // 1 hour

class IpInfoCache {
  private cache: Record<string, unknown>;

  constructor() {
    this.cache = {};
  }

  get<T = unknown>(ip: string): T | undefined {
    return this.cache[ip] as T | undefined;
  }

  set(ip: string, data: unknown) {
    this.cache[ip] = data;

    setTimeout(() => {
      delete this.cache[ip];
    }, IP_CACHE_TTL);
  }
}

const ipCache = new IpInfoCache();

export { ipCache };
