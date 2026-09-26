import type http from 'node:http';
import ipaddr from 'ipaddr.js';
import { UAParser } from 'ua-parser-js';
import { normalizeIpLiteral } from '../helpers/ip-addresses';
import { logger } from '../logger';
import type { TConnectionInfo } from '../types';

type TSocketLike = {
	_socket?: { remoteAddress?: unknown };
	socket?: { remoteAddress?: unknown };
};

type TClientIpOptions = {
	// Master switch (`server.trustProxy`). When false, forwarding headers are
	// never read and the TCP peer address is the client address.
	trustProxy?: boolean;
	// Comma-separated IPs/CIDRs whose forwarding headers are believed
	// (`server.trustedProxies`). Empty means DEFAULT_TRUSTED_PROXY_RANGES.
	trustedProxies?: string;
	// Header a trusted proxy puts the client address in (`server.clientIpHeader`).
	// Empty means X-Forwarded-For, falling back to X-Real-IP when it is absent.
	clientIpHeader?: string;
};

// Loopback and private ranges: a reverse proxy on the same host, a Docker
// bridge gateway, or a sidecar container (nginx, Caddy, cloudflared). Public
// peers are never trusted unless configured.
const DEFAULT_TRUSTED_PROXY_RANGES = '127.0.0.0/8, ::1/128, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7';

type TIpAddress = ipaddr.IPv4 | ipaddr.IPv6;
type TIpRange = [TIpAddress, number];

const parsedTrustedProxies = new Map<string, TIpRange[]>();

const parseIpAddress = (value: string): TIpAddress | undefined => {
	const normalized = normalizeIpLiteral(value);

	if (!ipaddr.isValid(normalized)) return undefined;

	// Collapses IPv4-mapped IPv6 to IPv4 so both forms match the same ranges and
	// produce the same rate-limit key.
	return ipaddr.process(normalized);
};

const parseTrustedProxies = (spec: string): TIpRange[] => {
	const cached = parsedTrustedProxies.get(spec);

	if (cached) return cached;

	const ranges: TIpRange[] = [];

	for (const entry of spec.split(',')) {
		const trimmed = entry.trim();

		if (!trimmed) continue;

		try {
			if (trimmed.includes('/')) {
				const [address, prefixLength] = ipaddr.parseCIDR(trimmed);
				if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
					if (prefixLength < 96) throw new Error('mapped CIDR extends beyond IPv4');
					ranges.push([address.toIPv4Address(), prefixLength - 96]);
				} else {
					ranges.push([address, prefixLength]);
				}
				continue;
			}

			const address = parseIpAddress(trimmed);

			if (!address) throw new Error('invalid address');

			ranges.push([address, address.kind() === 'ipv4' ? 32 : 128]);
		} catch {
			logger.warn('Ignoring invalid trusted proxy entry "%s"', trimmed);
		}
	}

	parsedTrustedProxies.set(spec, ranges);

	return ranges;
};

const getTrustedProxyRanges = (trustedProxies: string | undefined) => {
	const spec = String(trustedProxies ?? '').trim();

	return parseTrustedProxies(spec || DEFAULT_TRUSTED_PROXY_RANGES);
};

const isInRanges = (address: TIpAddress, ranges: TIpRange[]) =>
	ranges.some(([rangeAddress, prefixLength]) => {
		if (rangeAddress.kind() !== address.kind()) return false;
		return address.match(rangeAddress, prefixLength);
	});

const normalizeHeaderValue = (value: unknown): string | undefined => {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.join(',');
	return undefined;
};

const getPeerIp = (ws: unknown, req: http.IncomingMessage): string | undefined => {
	const parsedWs = ws && typeof ws === 'object' ? (ws as TSocketLike) : undefined;
	const remoteAddress =
		parsedWs?._socket?.remoteAddress ||
		parsedWs?.socket?.remoteAddress ||
		req?.socket?.remoteAddress ||
		req?.connection?.remoteAddress;

	return typeof remoteAddress === 'string' && remoteAddress.length > 0 ? remoteAddress : undefined;
};

// Walks X-Forwarded-For right to left. Each trusted hop appended the address it
// saw, so the first entry reached from an untrusted address is the client; the
// entries further left were supplied by that client and are ignored.
const resolveForwardedFor = (peer: TIpAddress, forwardedFor: string, ranges: TIpRange[]) => {
	const hops = forwardedFor
		.split(',')
		.map((hop) => hop.trim())
		.filter((hop) => hop.length > 0);

	let client = peer;

	for (let index = hops.length - 1; index >= 0 && isInRanges(client, ranges); index -= 1) {
		const hop = parseIpAddress(hops[index] ?? '');

		if (!hop) break;

		client = hop;
	}

	return client;
};

const getWsIp = (ws: unknown, req: http.IncomingMessage, options?: TClientIpOptions): string | undefined => {
	const rawPeerIp = getPeerIp(ws, req);

	if (!rawPeerIp) return undefined;

	const peer = parseIpAddress(rawPeerIp);

	if (!peer) return normalizeIpLiteral(rawPeerIp);

	if (options?.trustProxy !== true) return peer.toString();

	const ranges = getTrustedProxyRanges(options.trustedProxies);

	// Forwarding headers from anyone but a trusted proxy are client-controlled.
	if (!isInRanges(peer, ranges)) return peer.toString();

	const headers = req?.headers || {};
	const clientIpHeader = String(options.clientIpHeader ?? '')
		.trim()
		.toLowerCase();

	if (clientIpHeader && clientIpHeader !== 'x-forwarded-for') {
		const value = normalizeHeaderValue(headers[clientIpHeader])?.split(',')[0];
		const client = value ? parseIpAddress(value) : undefined;

		return (client ?? peer).toString();
	}

	const forwardedFor = normalizeHeaderValue(headers['x-forwarded-for']);

	if (forwardedFor?.trim()) {
		return resolveForwardedFor(peer, forwardedFor, ranges).toString();
	}

	if (!clientIpHeader) {
		const realIp = normalizeHeaderValue(headers['x-real-ip']);
		const client = realIp ? parseIpAddress(realIp) : undefined;

		if (client) return client.toString();
	}

	return peer.toString();
};

const getWsInfo = (ws: unknown, req: http.IncomingMessage, options?: TClientIpOptions): TConnectionInfo | undefined => {
	const ip = getWsIp(ws, req, options);
	const userAgent = req?.headers?.['user-agent'];

	if (!ip && !userAgent) return undefined;

	const parser = new UAParser(userAgent || '');
	const result = parser.getResult();

	return {
		ip,
		os: result.os.name ? [result.os.name, result.os.version].filter(Boolean).join(' ') : undefined,
		device: result.device.type
			? [result.device.vendor, result.device.model].filter(Boolean).join(' ').trim()
			: 'Desktop',
		userAgent: userAgent || undefined,
	};
};

export { DEFAULT_TRUSTED_PROXY_RANGES, getWsInfo, type TClientIpOptions };
