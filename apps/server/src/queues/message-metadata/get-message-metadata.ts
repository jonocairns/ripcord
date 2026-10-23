import type { TGenericObject, TMessageMetadata } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
// Parse-only entry point: fetching is done by fetchPreviewResource, whose
// address pinning works under Bun (link-preview-js pins via undici, which Bun
// replaces with a built-in that ignores custom dispatchers).
import { getPreviewFromContent } from 'link-preview-js/mobile';
import { db } from '../../db';
import { messages } from '../../db/schema';
import { extractUrls } from '../../helpers/urls-extractor';
import { fetchPreviewResource } from './fetch-preview-resource';

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

const urlMetadataParser = async (content: string): Promise<TMessageMetadata[]> => {
	try {
		const urls = extractUrls(content);

		if (!urls) return [];

		const promises = urls.map(async (url) => {
			const cached = lruGet(url);
			if (cached !== undefined) return cached;

			const resource = await fetchPreviewResource(url);

			if (!resource) return;

			const metadata = await getPreviewFromContent(resource);

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
