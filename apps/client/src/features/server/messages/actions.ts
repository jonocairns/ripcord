import type { TJoinedMessage } from '@sharkord/shared';
import { logDebug } from '@/helpers/browser-logger';
import { getTRPCClient } from '@/lib/trpc';
import { selectedChannelIdSelector } from '../channels/selectors';
import { useServerStore } from '../slice';
import { playSound } from '../sounds/actions';
import { SoundType } from '../types';
import { ownUserIdSelector } from '../users/selectors';
import { createFileAccessRefresher } from './file-access-refresher';
import type { TFileAccessToken } from './file-access-tokens';

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

export const setFileAccessTokens = (channelId: number, requestedFileIds: number[], tokens: TFileAccessToken[]) => {
	useServerStore.getState().setFileAccessTokens({ channelId, requestedFileIds, tokens });
};

const fileAccessRefresher = createFileAccessRefresher({
	// Resolved per call: this module loads inside the lib/trpc import cycle, so
	// reading getTRPCClient at module load would hit its temporal dead zone.
	getClient: () => getTRPCClient(),
	getServerId: () => useServerStore.getState().serverId,
	getMessagesMap: () => useServerStore.getState().messagesMap,
	setFileAccessTokens,
	onError: (channelId, error) => logDebug('File access token refresh failed', { channelId, error }),
});

export const refreshChannelFileAccessTokens = fileAccessRefresher.refreshChannel;

export const refreshLoadedFileAccessTokens = fileAccessRefresher.refreshLoadedChannels;

export const refreshExpiringFileAccessTokens = fileAccessRefresher.refreshExpiringChannels;

// CHANNEL_FILE_ACCESS_CHANGED: the channel's token rotated, or it turned private
// or public. Refresh its loaded files, and let file lists kept outside the
// message store (the moderator sheet) refetch.
export const handleChannelFileAccessChanged = (channelId: number) => {
	void refreshChannelFileAccessTokens(channelId);
	useServerStore.getState().bumpFileAccessChangeNonce();
};
