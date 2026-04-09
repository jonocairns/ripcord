import ipaddr from 'ipaddr.js';

type TIpFamily = 'ipv4' | 'ipv6';

type TResolvedIpAddresses = Partial<Record<TIpFamily, string>>;

const PRIVATE_IP_RANGES = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'private',
  'uniqueLocal'
]);

const normalizeIpLiteral = (ip: string): string => {
  let normalized = ip.trim();

  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }

  if (normalized.startsWith('::ffff:')) {
    return normalized.slice(7);
  }

  return normalized;
};

const isPrivateOrLocalIp = (ip: string): boolean => {
  try {
    const parsedIp = ipaddr.parse(normalizeIpLiteral(ip));

    return PRIVATE_IP_RANGES.has(parsedIp.range());
  } catch {
    return true;
  }
};

const isUnspecifiedBindAddress = (ip: string): boolean => {
  const normalized = normalizeIpLiteral(ip);

  return normalized === '0.0.0.0' || normalized === '::';
};

const formatHostForUrl = (host: string): string => {
  const normalized = host.trim();

  if (!normalized) {
    return normalized;
  }

  if (normalized.includes(':') && !normalized.startsWith('[')) {
    return `[${normalized}]`;
  }

  return normalized;
};

const resolvePreferredAddress = (
  addresses: TResolvedIpAddresses,
  preferredFamily: TIpFamily
): string | undefined => {
  const fallbackFamily = preferredFamily === 'ipv6' ? 'ipv4' : 'ipv6';

  return addresses[preferredFamily] ?? addresses[fallbackFamily];
};

const formatResolvedIpAddresses = (addresses: TResolvedIpAddresses): string => {
  const parts: string[] = [];

  if (addresses.ipv4) {
    parts.push(`ipv4=${addresses.ipv4}`);
  }

  if (addresses.ipv6) {
    parts.push(`ipv6=${addresses.ipv6}`);
  }

  return parts.join(', ') || 'unavailable';
};

export {
  formatHostForUrl,
  formatResolvedIpAddresses,
  isPrivateOrLocalIp,
  isUnspecifiedBindAddress,
  normalizeIpLiteral,
  resolvePreferredAddress
};
export type { TIpFamily, TResolvedIpAddresses };
