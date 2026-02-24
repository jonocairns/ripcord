const parseAllowedOrigins = (originsText: string): string[] => {
  return originsText
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
};

const normalizeOrigin = (origin: unknown): string | undefined => {
  if (typeof origin === 'string') {
    return origin;
  }

  if (Array.isArray(origin)) {
    return typeof origin[0] === 'string' ? origin[0] : undefined;
  }

  return undefined;
};

const normalizeHost = (host: unknown): string | undefined => {
  if (typeof host === 'string') {
    return host;
  }

  if (Array.isArray(host)) {
    return typeof host[0] === 'string' ? host[0] : undefined;
  }

  return undefined;
};

const isSameOriginHost = (
  requestOrigin: string | undefined,
  requestHost: unknown
): boolean => {
  if (!requestOrigin) {
    return false;
  }

  const host = normalizeHost(requestHost);

  if (!host) {
    return false;
  }

  try {
    const originUrl = new URL(requestOrigin);
    const hostUrl = new URL(`http://${host}`);

    return originUrl.hostname.toLowerCase() === hostUrl.hostname.toLowerCase();
  } catch {
    return false;
  }
};

const getAllowedOrigin = (
  requestOrigin: string | undefined,
  allowedOrigins: string[]
): string | undefined => {
  if (!requestOrigin) {
    return undefined;
  }

  if (allowedOrigins.includes('*')) {
    return '*';
  }

  return allowedOrigins.includes(requestOrigin) ? requestOrigin : undefined;
};

const isOriginAllowedForRequest = ({
  requestOrigin,
  requestHost,
  allowedOrigins
}: {
  requestOrigin: string | undefined;
  requestHost: unknown;
  allowedOrigins: string[];
}): boolean => {
  if (!requestOrigin) {
    return true;
  }

  if (allowedOrigins.includes('*')) {
    return true;
  }

  if (allowedOrigins.includes(requestOrigin)) {
    return true;
  }

  return isSameOriginHost(requestOrigin, requestHost);
};

export {
  getAllowedOrigin,
  isOriginAllowedForRequest,
  normalizeOrigin,
  parseAllowedOrigins
};
