import { DEFAULT_MESSAGES_LIMIT, type TJoinedMessage } from '@sharkord/shared';
import { addMessagesToStore } from './message-store';
import { useServerStore } from './server-store';
import { getTRPCClient } from './trpc';

const DEFAULT_INITIAL_MESSAGES_LIMIT = 40;
const DEFAULT_OLDER_MESSAGES_LIMIT = 30;

type TFetchMessagesPage = {
	channelId: number;
	cursor?: number | null;
	limit?: number;
};

const setSelectedChannel = (channelId: number | undefined) => {
	useServerStore.getState().setSelectedChannelId(channelId);
};

const fetchMessagesPage = async ({
	channelId,
	cursor = null,
	limit = DEFAULT_MESSAGES_LIMIT,
}: TFetchMessagesPage): Promise<{
	messages: TJoinedMessage[];
	nextCursor: number | null;
}> => {
	return getTRPCClient().messages.get.query({
		channelId,
		cursor,
		limit,
	});
};

const loadMessagesPageIntoStore = async ({
	channelId,
	cursor = null,
	limit = cursor === null ? DEFAULT_INITIAL_MESSAGES_LIMIT : DEFAULT_OLDER_MESSAGES_LIMIT,
}: TFetchMessagesPage) => {
	const response = await fetchMessagesPage({
		channelId,
		cursor,
		limit,
	});

	addMessagesToStore(channelId, response.messages, { prepend: true });
	return response;
};

const markChannelAsRead = async (channelId: number) => {
	await getTRPCClient().channels.markAsRead.mutate({ channelId });
};

const sendMessage = async (payload: { channelId: number; content: string; files?: string[] }) => {
	return getTRPCClient().messages.send.mutate({
		channelId: payload.channelId,
		content: payload.content,
		files: payload.files ?? [],
	});
};

const editMessage = async (payload: { content: string; messageId: number }) => {
	await getTRPCClient().messages.edit.mutate(payload);
};

const deleteMessage = async (payload: { messageId: number }) => {
	await getTRPCClient().messages.delete.mutate(payload);
};

const toggleMessageReaction = async (payload: { emoji: string; messageId: number }) => {
	await getTRPCClient().messages.toggleReaction.mutate(payload);
};

const signalTyping = async (payload: { channelId: number }) => {
	await getTRPCClient().messages.signalTyping.mutate(payload);
};

const deleteTemporaryFile = async (payload: { fileId: string }) => {
	await getTRPCClient().files.deleteTemporary.mutate(payload);
};

export {
	deleteMessage,
	deleteTemporaryFile,
	editMessage,
	fetchMessagesPage,
	loadMessagesPageIntoStore,
	markChannelAsRead,
	sendMessage,
	setSelectedChannel,
	signalTyping,
	toggleMessageReaction,
};
