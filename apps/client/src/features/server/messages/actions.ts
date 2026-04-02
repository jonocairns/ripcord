import type { TJoinedMessage } from '@sharkord/shared';
import { getTRPCClient } from '@/lib/trpc';
import { selectedChannelIdSelector } from '../channels/selectors';
import { useServerStore } from '../slice';
import { playSound } from '../sounds/actions';
import { SoundType } from '../types';
import { ownUserIdSelector } from '../users/selectors';

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
