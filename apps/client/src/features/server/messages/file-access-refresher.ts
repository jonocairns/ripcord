import type { TMessagesMap } from '../types';
import {
	chunkFileIds,
	getChannelIdsWithExpiringFileTokens,
	getChannelIdsWithLoadedFiles,
	getMessageFileIds,
	type TFileAccessToken,
} from './file-access-tokens';

type TFileAccessTokensClient = {
	files: {
		getAccessTokens: {
			query: (input: { channelId: number; fileIds: number[] }) => Promise<TFileAccessToken[]>;
		};
	};
};

type TFileAccessRefresherDeps = {
	getClient: () => TFileAccessTokensClient;
	getMessagesMap: () => TMessagesMap;
	setFileAccessTokens: (channelId: number, requestedFileIds: number[], tokens: TFileAccessToken[]) => void;
	onError?: (channelId: number, error: unknown) => void;
};

type TChannelRefresh = {
	running: Promise<void>;
	rerun: boolean;
};

// Keeps the file tokens of loaded messages current by asking the server to
// re-sign them. File URLs are built from the store at render time, so media and
// download cards pick up the new tokens on their next render.
const createFileAccessRefresher = (deps: TFileAccessRefresherDeps) => {
	const activeRefreshes = new Map<number, TChannelRefresh>();

	const requestChannelTokens = async (channelId: number) => {
		const fileIds = getMessageFileIds(deps.getMessagesMap()[channelId] ?? []);

		for (const batch of chunkFileIds(fileIds)) {
			let tokens: TFileAccessToken[];

			try {
				tokens = await deps.getClient().files.getAccessTokens.query({ channelId, fileIds: batch });
			} catch (error) {
				// An older server without the route, a dropped socket, or lost access.
				// Keep the current tokens; the next trigger tries again.
				deps.onError?.(channelId, error);
				return;
			}

			deps.setFileAccessTokens(channelId, batch, tokens);
		}
	};

	// One refresh per channel at a time. A request made while one is in flight
	// runs once more after it, because the in-flight request may have been
	// signed before the change that prompted the new one (a rotation).
	const refreshChannel = (channelId: number): Promise<void> => {
		const active = activeRefreshes.get(channelId);

		if (active) {
			active.rerun = true;
			return active.running;
		}

		const refresh: TChannelRefresh = { running: Promise.resolve(), rerun: false };

		refresh.running = (async () => {
			try {
				do {
					refresh.rerun = false;
					await requestChannelTokens(channelId);
				} while (refresh.rerun);
			} finally {
				activeRefreshes.delete(channelId);
			}
		})();

		activeRefreshes.set(channelId, refresh);

		return refresh.running;
	};

	const refreshChannels = async (channelIds: number[]) => {
		await Promise.all(channelIds.map(refreshChannel));
	};

	// After a confirmed rejoin: events may have been missed while disconnected.
	const refreshLoadedChannels = () => refreshChannels(getChannelIdsWithLoadedFiles(deps.getMessagesMap()));

	const refreshExpiringChannels = (now: number) =>
		refreshChannels(getChannelIdsWithExpiringFileTokens(deps.getMessagesMap(), now));

	return { refreshChannel, refreshLoadedChannels, refreshExpiringChannels };
};

export type { TFileAccessTokensClient };
export { createFileAccessRefresher };
