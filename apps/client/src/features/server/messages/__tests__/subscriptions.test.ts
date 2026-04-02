import type { TJoinedMessage } from '@sharkord/shared';
import { describe, expect, it, mock } from 'bun:test';
import { subscribeToMessageEvents } from '../subscriptions-core';

const createMessage = (overrides: Partial<TJoinedMessage> = {}) =>
	({
		id: 1,
		channelId: 12,
		userId: 4,
		content: '<p>Hello</p>',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		metadata: [],
		files: [],
		reactions: [],
		replyId: null,
		reply: null,
		mentions: [],
		mentionsEveryone: false,
		embeds: [],
		...overrides,
	}) as unknown as TJoinedMessage;

describe('subscribeToMessageEvents', () => {
	it('subscribes only to message create, update, and delete events', () => {
		const onNewHandlers: Array<{ onData: (message: TJoinedMessage) => void }> = [];
		const onUpdateHandlers: Array<{ onData: (message: TJoinedMessage) => void }> = [];
		const onDeleteHandlers: Array<{ onData: (payload: { messageId: number; channelId: number }) => void }> = [];
		const unsubscribe = {
			onNew: mock(() => {}),
			onUpdate: mock(() => {}),
			onDelete: mock(() => {}),
		};
		const handlers = {
			addMessages: mock(() => {}),
			updateMessage: mock(() => {}),
			deleteMessage: mock(() => {}),
		};

		const stop = subscribeToMessageEvents(
			{
				messages: {
					onNew: {
						subscribe: (_input, nextHandlers) => {
							onNewHandlers.push(nextHandlers);
							return { unsubscribe: unsubscribe.onNew };
						},
					},
					onUpdate: {
						subscribe: (_input, nextHandlers) => {
							onUpdateHandlers.push(nextHandlers);
							return { unsubscribe: unsubscribe.onUpdate };
						},
					},
					onDelete: {
						subscribe: (_input, nextHandlers) => {
							onDeleteHandlers.push(nextHandlers);
							return { unsubscribe: unsubscribe.onDelete };
						},
					},
				},
			},
			handlers,
		);

		expect(onNewHandlers).toHaveLength(1);
		expect(onUpdateHandlers).toHaveLength(1);
		expect(onDeleteHandlers).toHaveLength(1);

		const createdMessage = createMessage({ id: 11, channelId: 22 });
		const updatedMessage = createMessage({ id: 12, channelId: 23 });

		onNewHandlers[0]?.onData(createdMessage);
		onUpdateHandlers[0]?.onData(updatedMessage);
		onDeleteHandlers[0]?.onData({ messageId: 33, channelId: 24 });

		expect(handlers.addMessages).toHaveBeenCalledWith(22, [createdMessage], {}, true);
		expect(handlers.updateMessage).toHaveBeenCalledWith(23, updatedMessage);
		expect(handlers.deleteMessage).toHaveBeenCalledWith(24, 33);

		stop();

		expect(unsubscribe.onNew).toHaveBeenCalledTimes(1);
		expect(unsubscribe.onUpdate).toHaveBeenCalledTimes(1);
		expect(unsubscribe.onDelete).toHaveBeenCalledTimes(1);
	});
});
