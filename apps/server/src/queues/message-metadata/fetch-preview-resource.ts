import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { IPreFetchedResource } from 'link-preview-js/mobile';

const PREVIEW_TIMEOUT_MS = 5000;
const MAX_PREVIEW_REDIRECTS = 5;
// Preview metadata lives in <head>. Cap the decoded body so a huge or endless
// page (or a compression bomb) cannot exhaust server memory.
const MAX_PREVIEW_BYTES = 1024 * 1024;

type TPreviewNetwork = {
	resolveHost: (hostname: string) => Promise<string[]>;
	isAllowedAddress: (address: string) => boolean;
};

const stripIpv6Brackets = (hostname: string) => hostname.replace(/^\[|\]$/g, '');

// Only globally routable unicast addresses may be fetched. ipaddr.process()
// unwraps IPv4-mapped IPv6 (::ffff:127.0.0.1) so it cannot smuggle a private
// target past the range check.
const isPublicAddress = (address: string): boolean => {
	if (!ipaddr.isValid(address)) return false;

	return ipaddr.process(address).range() === 'unicast';
};

// Synchronous guard for a single URL: http/https only, and literal IPs must be
// public. Hostnames are vetted after DNS resolution in fetchPreviewResource.
const isUrlSafeForPreview = (url: string): boolean => {
	if (!URL.canParse(url)) return false;

	const parsed = new URL(url);

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return false;
	}

	// URL.hostname keeps the brackets around IPv6 literals but isIP() rejects them.
	const hostname = stripIpv6Brackets(parsed.hostname);

	return !isIP(hostname) || isPublicAddress(hostname);
};

const publicNetwork: TPreviewNetwork = {
	resolveHost: async (hostname) => {
		const addresses = await dns.lookup(hostname, { all: true });

		return addresses.map((entry) => entry.address);
	},
	isAllowedAddress: isPublicAddress,
};

const resolveAllowedAddress = async (hostname: string, network: TPreviewNetwork): Promise<string | undefined> => {
	const literal = stripIpv6Brackets(hostname);
	const addresses = isIP(literal) ? [literal] : await network.resolveHost(literal);
	const [first] = addresses;

	// Reject if any record is private so a mixed answer can't be retried into one.
	if (!first || !addresses.every(network.isAllowedAddress)) return undefined;

	return first;
};

// Connect to the vetted address rather than letting fetch() resolve the name
// again, which a DNS-rebinding host could answer with an internal address.
// Host and TLS SNI keep the original name, so virtual hosting and certificate
// validation still apply to the hostname the user posted.
const fetchPinned = (target: URL, address: string, signal: AbortSignal) => {
	const pinned = new URL(target);
	pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;

	const hostname = stripIpv6Brackets(target.hostname);

	return fetch(pinned, {
		redirect: 'manual',
		signal,
		headers: { Host: target.host },
		...(isIP(hostname) ? {} : { tls: { serverName: hostname } }),
	});
};

const readCappedText = async (response: Response): Promise<string> => {
	if (!response.body) return '';

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	while (total < MAX_PREVIEW_BYTES) {
		const { done, value } = await reader.read();

		if (done) break;

		chunks.push(value);
		total += value.byteLength;
	}

	await reader.cancel().catch(() => {});

	return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_PREVIEW_BYTES));
};

// Fetches a user-posted URL for link previews, re-running the SSRF checks on
// every redirect hop. Returns undefined when any hop targets a non-public
// address or the redirect chain is too long.
const fetchPreviewResource = async (
	url: string,
	network: TPreviewNetwork = publicNetwork,
): Promise<IPreFetchedResource | undefined> => {
	if (!URL.canParse(url)) return undefined;

	const signal = AbortSignal.timeout(PREVIEW_TIMEOUT_MS);
	let target = new URL(url);

	for (let hop = 0; hop <= MAX_PREVIEW_REDIRECTS; hop++) {
		if (!isUrlSafeForPreview(target.href)) return undefined;

		const address = await resolveAllowedAddress(target.hostname, network);

		if (!address) return undefined;

		const response = await fetchPinned(target, address, signal);
		const location = response.headers.get('location');

		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel();
			target = new URL(location, target);
			continue;
		}

		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key] = value;
		});

		return {
			url: target.href,
			status: response.status,
			headers,
			data: await readCappedText(response),
		};
	}

	return undefined;
};

export { fetchPreviewResource, isUrlSafeForPreview, MAX_PREVIEW_BYTES, MAX_PREVIEW_REDIRECTS };
