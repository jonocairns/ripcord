import type { TJoinedMessage } from '@sharkord/shared';

type TMessageSubscription = {
	unsubscribe: () => void;
};

type TMessagesSubscriptionsClient = {
	messages: {
		onNew: {
			subscribe: (
				_input: undefined,
				handlers: {
					onData: (message: TJoinedMessage) => void;
					onError: (err: unknown) => void;
				},
			) => TMessageSubscription;
		};
		onUpdate: {
			subscribe: (
				_input: undefined,
				handlers: {
					onData: (message: TJoinedMessage) => void;
					onError: (err: unknown) => void;
				},
			) => TMessageSubscription;
		};
		onDelete: {
			subscribe: (
				_input: undefined,
				handlers: {
					onData: (payload: { messageId: number; channelId: number }) => void;
					onError: (err: unknown) => void;
				},
			) => TMessageSubscription;
		};
	};
};

type TMessageSubscriptionHandlers = {
	addMessages: (
		channelId: number,
		messages: TJoinedMessage[],
		opts?: { prepend?: boolean },
		isSubscriptionMessage?: boolean,
	) => void;
	updateMessage: (channelId: number, message: TJoinedMessage) => void;
	deleteMessage: (channelId: number, messageId: number) => void;
};

const subscribeToMessageEvents = (trpc: TMessagesSubscriptionsClient, handlers: TMessageSubscriptionHandlers) => {
	const onMessageSub = trpc.messages.onNew.subscribe(undefined, {
		onData: (message: TJoinedMessage) => handlers.addMessages(message.channelId, [message], {}, true),
		onError: (err) => console.error('onMessage subscription error:', err),
	});

	const onMessageUpdateSub = trpc.messages.onUpdate.subscribe(undefined, {
		onData: (message: TJoinedMessage) => handlers.updateMessage(message.channelId, message),
		onError: (err) => console.error('onMessageUpdate subscription error:', err),
	});

	const onMessageDeleteSub = trpc.messages.onDelete.subscribe(undefined, {
		onData: ({ messageId, channelId }) => handlers.deleteMessage(channelId, messageId),
		onError: (err) => console.error('onMessageDelete subscription error:', err),
	});

	return () => {
		onMessageSub.unsubscribe();
		onMessageUpdateSub.unsubscribe();
		onMessageDeleteSub.unsubscribe();
	};
};

export { subscribeToMessageEvents };
export type { TMessageSubscriptionHandlers, TMessagesSubscriptionsClient };
