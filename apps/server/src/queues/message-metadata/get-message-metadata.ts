import dns from 'node:dns';
import { isIP } from 'node:net';
import type { TGenericObject, TMessageMetadata } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import ipaddr from 'ipaddr.js';
import { getLinkPreview } from 'link-preview-js';
import { db } from '../../db';
import { messages } from '../../db/schema';
import { extractUrls } from '../../helpers/urls-extractor';

const METADATA_CACHE_MAX = 500;

// LRU cache: insertion order is preserved in Map; we evict the oldest entry when full.
const metadataCache = new Map<string, TGenericObject>();

const lruGet = (key: string): TGenericObject | undefined => {
	const value = metadataCache.get(key);
	if (value !== undefined) {
		// Refresh recency by re-inserting
		metadataCache.delete(key);
		metadataCache.set(key, value);
	}
	return value;
};

const lruSet = (key: string, value: TGenericObject): void => {
	if (metadataCache.has(key)) metadataCache.delete(key);
	else if (metadataCache.size >= METADATA_CACHE_MAX) {
		// Evict the least-recently-used (first) entry
		const lruKey = metadataCache.keys().next().value;
		if (lruKey !== undefined) metadataCache.delete(lruKey);
	}
	metadataCache.set(key, value);
};

const isPrivateIP = (ip: string): boolean => {
	try {
		const addr = ipaddr.parse(ip);
		const range = addr.range();

		const blockedRanges = ['unspecified', 'broadcast', 'multicast', 'linkLocal', 'loopback', 'private', 'uniqueLocal'];

		return blockedRanges.includes(range);
	} catch {
		return true; // if we can't parse it, block it
	}
};

// First-hop guard, reusable per redirect hop: http/https only + literal private-IP block.
// DNS-based private-IP rejection is handled separately by resolveDNSHost.
export const isUrlSafeForPreview = (url: string): boolean => {
	if (!URL.canParse(url)) return false;

	const parsed = new URL(url);

	// allow only http and https protocols
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return false;
	}

	// it's already an ip address, check if it's private
	if (isIP(parsed.hostname) && isPrivateIP(parsed.hostname)) {
		return false;
	}

	return true;
};

const urlMetadataParser = async (content: string): Promise<TMessageMetadata[]> => {
	try {
		const urls = extractUrls(content);

		if (!urls) return [];

		const promises = urls.map(async (url) => {
			const cached = lruGet(url);
			if (cached !== undefined) return cached;

			if (!isUrlSafeForPreview(url)) {
				return;
			}

			const metadata = await getLinkPreview(url, {
				timeout: 5000,
				// Don't transparently follow redirects: a 3xx Location could point at a
				// private/internal target (SSRF). Handle them manually so the same
				// protocol + private-IP guard (and resolveDNSHost) re-runs on each hop.
				followRedirects: 'manual',
				handleRedirects: (_baseURL: string, forwardedURL: string) => isUrlSafeForPreview(forwardedURL),
				resolveDNSHost: async (url: string) => {
					return new Promise((resolve, reject) => {
						try {
							const hostname = new URL(url).hostname;

							dns.lookup(hostname, { all: true }, (err, addresses) => {
								if (err) {
									reject(err);
									return;
								}

								for (const entry of addresses) {
									if (isPrivateIP(entry.address)) {
										reject(new Error('Cannot resolve private IP addresses'));
										return;
									}
								}

								const firstAddress = addresses[0]?.address;

								if (!firstAddress) {
									reject(new Error('No addresses found'));
									return;
								}

								resolve(firstAddress);
							});
						} catch (error) {
							reject(error);
						}
					});
				},
			});

			if (!metadata) return;

			lruSet(url, metadata);

			return metadata;
		});

		const metadata = (await Promise.all(promises)) as TMessageMetadata[]; // TODO: fix these types

		return metadata ?? [];
	} catch {
		// ignore
	}

	return [];
};

export const processMessageMetadata = async (content: string, messageId: number) => {
	const metadata = await urlMetadataParser(content);

	return db
		.update(messages)
		.set({
			metadata,
			updatedAt: Date.now(),
		})
		.where(eq(messages.id, messageId))
		.returning()
		.get();
};
