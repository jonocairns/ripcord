import type { TIptvChannel } from '@sharkord/shared';
import dns from 'dns';
import ipaddr from 'ipaddr.js';
import { isIP } from 'net';

const PLAYLIST_CACHE_TTL_MS = 60_000;
const MAX_PLAYLIST_REDIRECTS = 5;
const PLAYLIST_FETCH_TIMEOUT_MS = 15_000;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

type TPlaylistCacheEntry = {
  expiresAt: number;
  channels: TIptvChannel[];
};

const playlistCache = new Map<string, TPlaylistCacheEntry>();

const isPrivateOrSpecialIpAddress = (ipAddress: string): boolean => {
  try {
    const parsedAddress = ipaddr.parse(ipAddress);

    if (
      parsedAddress.kind() === 'ipv6' &&
      'isIPv4MappedAddress' in parsedAddress &&
      typeof parsedAddress.isIPv4MappedAddress === 'function' &&
      parsedAddress.isIPv4MappedAddress() &&
      'toIPv4Address' in parsedAddress &&
      typeof parsedAddress.toIPv4Address === 'function'
    ) {
      return isPrivateOrSpecialIpAddress(
        parsedAddress.toIPv4Address().toString()
      );
    }

    const blockedRanges = new Set([
      'unspecified',
      'broadcast',
      'multicast',
      'linkLocal',
      'loopback',
      'private',
      'uniqueLocal',
      'reserved',
      'carrierGradeNat'
    ]);

    return blockedRanges.has(parsedAddress.range());
  } catch {
    return true;
  }
};

const resolveHostnameAddresses = async (
  hostname: string
): Promise<string[]> => {
  return await new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }

      const resolvedAddresses = addresses
        .map((entry) => entry.address)
        .filter((address) => address.length > 0);

      resolve(resolvedAddresses);
    });
  });
};

const assertSafeIptvUrl = async (inputUrl: string): Promise<void> => {
  if (!URL.canParse(inputUrl)) {
    throw new Error('Invalid IPTV URL');
  }

  const parsedUrl = new URL(inputUrl);

  if (!ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
    throw new Error('Only http/https IPTV URLs are allowed');
  }

  const hostname = parsedUrl.hostname.trim();

  if (!hostname) {
    throw new Error('IPTV URL host is missing');
  }

  if (hostname.toLowerCase() === 'localhost') {
    throw new Error('Localhost IPTV URLs are not allowed');
  }

  if (isIP(hostname)) {
    if (isPrivateOrSpecialIpAddress(hostname)) {
      throw new Error('Private or special IP addresses are not allowed');
    }

    return;
  }

  const resolvedAddresses = await resolveHostnameAddresses(hostname);

  if (resolvedAddresses.length === 0) {
    throw new Error('Failed to resolve IPTV URL host');
  }

  for (const resolvedAddress of resolvedAddresses) {
    if (isPrivateOrSpecialIpAddress(resolvedAddress)) {
      throw new Error('Resolved IPTV URL points to a private IP address');
    }
  }
};

const isRedirectStatus = (statusCode: number): boolean => {
  return [301, 302, 303, 307, 308].includes(statusCode);
};

const fetchPlaylistContent = async (
  playlistUrl: string
): Promise<{ content: string; finalUrl: string }> => {
  let currentUrl = playlistUrl;

  for (
    let redirectCount = 0;
    redirectCount <= MAX_PLAYLIST_REDIRECTS;
    redirectCount += 1
  ) {
    await assertSafeIptvUrl(currentUrl);

    const response = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PLAYLIST_FETCH_TIMEOUT_MS)
    });

    if (isRedirectStatus(response.status)) {
      const locationHeader = response.headers.get('location');

      if (!locationHeader) {
        throw new Error(
          'Playlist redirect response did not include a location'
        );
      }

      const nextUrl = new URL(locationHeader, currentUrl).toString();
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch IPTV playlist (${response.status})`);
    }

    return {
      content: await response.text(),
      finalUrl: currentUrl
    };
  }

  throw new Error('IPTV playlist exceeded maximum redirect limit');
};

const parseAttributes = (rawAttributes: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const attrRegex = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]+))/g;

  let match = attrRegex.exec(rawAttributes);

  while (match) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4];

    if (key) {
      attributes[key] = value ?? '';
    }

    match = attrRegex.exec(rawAttributes);
  }

  return attributes;
};

const parsePlaylist = (playlistContent: string): TIptvChannel[] => {
  const lines = playlistContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const channels: TIptvChannel[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (!line) {
      continue;
    }

    if (!line.startsWith('#EXTINF')) {
      continue;
    }

    const extinfContent = line.startsWith('#EXTINF:')
      ? line.slice('#EXTINF:'.length)
      : line.slice('#EXTINF'.length);
    const commaIndex = extinfContent.indexOf(',');
    const attributesPart =
      commaIndex >= 0 ? extinfContent.slice(0, commaIndex) : extinfContent;
    const fallbackName =
      commaIndex >= 0 ? extinfContent.slice(commaIndex + 1).trim() : '';
    const attributes = parseAttributes(attributesPart);

    let streamUrl: string | undefined;

    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j];

      if (!candidate) {
        continue;
      }

      if (candidate.startsWith('#EXTINF')) {
        break;
      }

      if (candidate.startsWith('#')) {
        continue;
      }

      streamUrl = candidate;
      i = j;
      break;
    }

    if (!streamUrl) {
      continue;
    }

    const name = attributes['tvg-name']?.trim() || fallbackName;
    const logo = attributes['tvg-logo']?.trim();
    const group = attributes['group-title']?.trim();
    const nextChannel: TIptvChannel = {
      name: name || `Channel ${channels.length + 1}`,
      url: streamUrl
    };

    if (logo) {
      nextChannel.logo = logo;
    }

    if (group) {
      nextChannel.group = group;
    }

    channels.push(nextChannel);
  }

  return channels;
};

const resolvePlaylistUrl = (inputUrl: string, baseUrl: string): string => {
  if (URL.canParse(inputUrl, baseUrl)) {
    return new URL(inputUrl, baseUrl).toString();
  }

  return inputUrl;
};

const fetchAndParsePlaylist = async (url: string): Promise<TIptvChannel[]> => {
  const now = Date.now();
  const cached = playlistCache.get(url);

  if (cached && cached.expiresAt > now) {
    return cached.channels;
  }

  const { content, finalUrl } = await fetchPlaylistContent(url);
  const parsedChannels = parsePlaylist(content);
  const validationCache = new Map<string, Promise<boolean>>();

  const isSafeUrl = (inputUrl: string): Promise<boolean> => {
    const cached = validationCache.get(inputUrl);

    if (cached) {
      return cached;
    }

    const promise = assertSafeIptvUrl(inputUrl).then(
      () => true,
      () => false
    );

    validationCache.set(inputUrl, promise);
    return promise;
  };

  const resolved = parsedChannels.map((channel) => ({
    channel,
    resolvedUrl: resolvePlaylistUrl(channel.url, finalUrl),
    resolvedLogoUrl: channel.logo
      ? resolvePlaylistUrl(channel.logo, finalUrl)
      : undefined
  }));

  const urlsToValidate = new Set<string>();

  for (const entry of resolved) {
    urlsToValidate.add(entry.resolvedUrl);

    if (entry.resolvedLogoUrl) {
      urlsToValidate.add(entry.resolvedLogoUrl);
    }
  }

  await Promise.all([...urlsToValidate].map((u) => isSafeUrl(u)));

  const safeChannels: TIptvChannel[] = [];

  for (const { channel, resolvedUrl, resolvedLogoUrl } of resolved) {
    if (!(await isSafeUrl(resolvedUrl))) {
      continue;
    }

    const safeLogoUrl =
      resolvedLogoUrl && (await isSafeUrl(resolvedLogoUrl))
        ? resolvedLogoUrl
        : undefined;

    safeChannels.push({
      ...channel,
      url: resolvedUrl,
      logo: safeLogoUrl
    });
  }

  if (safeChannels.length === 0) {
    throw new Error('No safe IPTV channels found in playlist');
  }

  playlistCache.set(url, {
    channels: safeChannels,
    expiresAt: now + PLAYLIST_CACHE_TTL_MS
  });

  return safeChannels;
};

const clearIptvPlaylistCache = () => {
  playlistCache.clear();
};

export {
  assertSafeIptvUrl,
  clearIptvPlaylistCache,
  fetchAndParsePlaylist,
  parsePlaylist
};
