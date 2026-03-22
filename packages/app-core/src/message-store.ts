import { TYPING_MS, type TJoinedMessage } from '@sharkord/shared';
import { getEffects } from './adapters';
import { selectedChannelIdSelector } from './channels-selectors';
import { getTRPCClient } from './trpc';
import { useServerStore } from './server-store';
import { ownUserIdSelector } from './users-selectors';

const typingTimeouts: Record<string, ReturnType<typeof setTimeout>> = {};

const getTypingKey = (channelId: number, userId: number) => `${channelId}-${userId}`;

const addMessagesToStore = (
	channelId: number,
	messages: TJoinedMessage[],
	opts: { prepend?: boolean } = {},
	isSubscriptionMessage = false,
) => {
	const state = useServerStore.getState();
	const selectedChannelId = selectedChannelIdSelector(state);

	useServerStore.getState().addMessages({ channelId, messages, opts });

	messages.forEach((message) => {
		removeTypingUserFromStore(channelId, message.userId);
	});

	if (!isSubscriptionMessage || messages.length === 0) {
		return;
	}

	const ownUserId = ownUserIdSelector(useServerStore.getState());
	const targetMessage = messages[0];
	const isOwnMessage = ownUserId === targetMessage?.userId;

	if (channelId === selectedChannelId && !isOwnMessage) {
		void getTRPCClient().channels.markAsRead.mutate({ channelId });
	}

	getEffects()?.onMessageReceived?.({
		channelId,
		isOwnMessage,
		messageId: targetMessage?.id ?? -1,
	});
};

const updateMessageInStore = (channelId: number, message: TJoinedMessage) => {
	useServerStore.getState().updateMessage({ channelId, message });
};

const deleteMessageFromStore = (channelId: number, messageId: number) => {
	useServerStore.getState().deleteMessage({ channelId, messageId });
};

const addTypingUserToStore = (channelId: number, userId: number) => {
	useServerStore.getState().addTypingUser({ channelId, userId });

	const timeoutKey = getTypingKey(channelId, userId);

	if (typingTimeouts[timeoutKey]) {
		clearTimeout(typingTimeouts[timeoutKey]);
	}

	typingTimeouts[timeoutKey] = setTimeout(() => {
		removeTypingUserFromStore(channelId, userId);
		delete typingTimeouts[timeoutKey];
	}, TYPING_MS + 500);
};

const removeTypingUserFromStore = (channelId: number, userId: number) => {
	useServerStore.getState().removeTypingUser({ channelId, userId });
};

export {
	addMessagesToStore,
	addTypingUserToStore,
	deleteMessageFromStore,
	removeTypingUserFromStore,
	updateMessageInStore,
};
