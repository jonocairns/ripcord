import type http from 'node:http';
import { UAParser } from 'ua-parser-js';
import { normalizeIpLiteral } from '../helpers/ip-addresses';
import type { TConnectionInfo } from '../types';

// TODO: this code is shit and needs to be improved later

type TSocketLike = {
	_socket?: { remoteAddress?: unknown };
	socket?: { remoteAddress?: unknown };
};

type TGetWsInfoOptions = {
	trustProxy?: boolean;
};

const normalizeIpCandidate = (value: unknown): string | undefined => {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value[0];
	if (value === null || value === undefined) return undefined;
	return String(value);
};

const getWsIp = (ws: unknown, req: http.IncomingMessage, options?: TGetWsInfoOptions): string | undefined => {
	const parsedWs = ws && typeof ws === 'object' ? (ws as TSocketLike) : undefined;

	const headers = req?.headers || {};
	const trustProxy = options?.trustProxy === true;

	const proxyIp = normalizeIpCandidate(
		parsedWs?._socket?.remoteAddress ||
			parsedWs?.socket?.remoteAddress ||
			req?.socket?.remoteAddress ||
			req?.connection?.remoteAddress,
	);

	let ip = trustProxy
		? normalizeIpCandidate(
				headers['cf-connecting-ip'] ||
					headers['cf-real-ip'] ||
					headers['x-real-ip'] ||
					headers['x-forwarded-for'] ||
					headers['x-client-ip'] ||
					headers['x-cluster-client-ip'] ||
					headers['forwarded-for'] ||
					headers.forwarded ||
					proxyIp,
			)
		: proxyIp;

	if (!ip) return undefined;

	if (ip.includes(',')) {
		// With a single trusted reverse proxy, the right-most X-Forwarded-For entry is the
		// address the proxy actually observed; entries to its left are attacker-supplied and
		// must not be trusted for attribution or rate limiting.
		const parts = ip
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		ip = parts[parts.length - 1];
	}

	return ip ? normalizeIpLiteral(ip) : undefined;
};

const getWsInfo = (
	ws: unknown,
	req: http.IncomingMessage,
	options?: TGetWsInfoOptions,
): TConnectionInfo | undefined => {
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

export { getWsInfo };
