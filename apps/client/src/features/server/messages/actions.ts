import type { TJoinedMessage } from '@sharkord/shared';
import { logDebug } from '@/helpers/browser-logger';
import { getTRPCClient } from '@/lib/trpc';
import { selectedChannelIdSelector } from '../channels/selectors';
import { useServerStore } from '../slice';
import { playSound } from '../sounds/actions';
import { SoundType } from '../types';
import { ownUserIdSelector } from '../users/selectors';
import { createFileAccessRefresher } from './file-access-refresher';
import {
	getExpiringFileIds,
	getFileIds,
	getLoadedFiles,
	getMessageFiles,
	type TFileAccessToken,
} from './file-access-tokens';

export const addMessages = (
	channelId: number,
	messages: TJoinedMessage[],
	opts: { prepend?: boolean } = {},
	isSubscriptionMessage = false,
) => {
	const state = useServerStore.getState();
	const selectedChannelId = selectedChannelIdSelector(state);

	useServerStore.getState().addMessages({ channelId, messages, opts });

	if (isSubscriptionMessage && messages.length > 0) {
		const state = useServerStore.getState();
		const ownUserId = ownUserIdSelector(state);
		const targetMessage = messages[0];
		const isFromOwnUser = ownUserId === targetMessage.userId;

		if (!isFromOwnUser) {
			playSound(SoundType.MESSAGE_RECEIVED);
		}

		if (channelId === selectedChannelId && !isFromOwnUser) {
			// user is viewing this channel - mark messages as read
			const trpc = getTRPCClient();

			try {
				trpc.channels.markAsRead.mutate({ channelId });
			} catch {
				// ignore errors
			}
		}
	}
};

export const updateMessage = (channelId: number, message: TJoinedMessage) => {
	useServerStore.getState().updateMessage({ channelId, message });
};

export const deleteMessage = (channelId: number, messageId: number) => {
	useServerStore.getState().deleteMessage({ channelId, messageId });
};

export const setFileAccessTokens = (tokens: TFileAccessToken[]) => {
	useServerStore.getState().setFileAccessTokens({ tokens });
};

const fileAccessRefresher = createFileAccessRefresher({
	// Resolved per call: this module loads inside the lib/trpc import cycle, so
	// reading getTRPCClient at module load would hit its temporal dead zone.
	getClient: () => getTRPCClient(),
	getServerId: () => useServerStore.getState().serverId,
	applyTokens: setFileAccessTokens,
	onError: (error) => logDebug('File access token refresh failed', error),
});

const getLoadedChannelFiles = (channelId: number) =>
	getMessageFiles(useServerStore.getState().messagesMap[channelId] ?? []);

export const refreshChannelFileAccessTokens = (channelId: number) =>
	fileAccessRefresher.refreshFiles(getFileIds(getLoadedChannelFiles(channelId)));

// After a confirmed rejoin: a rotation may have been missed while disconnected.
export const refreshLoadedFileAccessTokens = () =>
	fileAccessRefresher.refreshFiles(getFileIds(getLoadedFiles(useServerStore.getState().messagesMap)));

export const refreshExpiringFileAccessTokens = (now: number) =>
	fileAccessRefresher.refreshFiles(getExpiringFileIds(getLoadedFiles(useServerStore.getState().messagesMap), now));

// CHANNEL_FILE_ACCESS_CHANGED: the channel's file access token rotated. Refresh
// its loaded files, and let file lists kept outside the message store (the
// moderator sheet) refresh theirs.
export const handleChannelFileAccessChanged = (channelId: number) => {
	void refreshChannelFileAccessTokens(channelId);
	useServerStore.getState().bumpFileAccessChangeNonce();
};
