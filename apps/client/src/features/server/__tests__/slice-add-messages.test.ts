import { beforeEach, describe, expect, it } from 'bun:test';
import type { TJoinedMessage } from '@sharkord/shared';
import { useServerStore } from '../slice';

const createMessage = (id: number, createdAt: number): TJoinedMessage =>
	({
		id,
		channelId: 1,
		userId: 1,
		content: '',
		createdAt,
		updatedAt: createdAt,
		metadata: [],
		files: [],
		reactions: [],
		replyId: null,
		reply: null,
		mentions: [],
		mentionsEveryone: false,
		embeds: [],
	}) as unknown as TJoinedMessage;

describe('useServerStore.addMessages', () => {
	beforeEach(() => {
		useServerStore.setState({ messagesMap: {}, protectedMessagePrefixCounts: {} });
	});

	it('appends messages keeping createdAt order', () => {
		const store = useServerStore.getState();

		store.addMessages({
			channelId: 1,
			messages: [createMessage(1, 100), createMessage(2, 200)],
		});
		store.addMessages({
			channelId: 1,
			messages: [createMessage(3, 300)],
		});

		const result = useServerStore.getState().messagesMap[1];
		expect(result?.map((m) => m.id)).toEqual([1, 2, 3]);
	});

	it('prepends older messages without re-sorting', () => {
		const store = useServerStore.getState();

		store.addMessages({
			channelId: 1,
			messages: [createMessage(3, 300), createMessage(4, 400)],
		});
		store.addMessages({
			channelId: 1,
			messages: [createMessage(1, 100), createMessage(2, 200)],
			opts: { prepend: true },
		});

		const result = useServerStore.getState().messagesMap[1];
		expect(result?.map((m) => m.id)).toEqual([1, 2, 3, 4]);
	});

	it('falls back to a full sort when batches interleave', () => {
		const store = useServerStore.getState();

		store.addMessages({
			channelId: 1,
			messages: [createMessage(1, 100), createMessage(3, 300)],
		});
		store.addMessages({
			channelId: 1,
			messages: [createMessage(2, 200)],
		});

		const result = useServerStore.getState().messagesMap[1];
		expect(result?.map((m) => m.id)).toEqual([1, 2, 3]);
	});

	it('skips duplicates by id', () => {
		const store = useServerStore.getState();

		store.addMessages({
			channelId: 1,
			messages: [createMessage(1, 100)],
		});
		store.addMessages({
			channelId: 1,
			messages: [createMessage(1, 100), createMessage(2, 200)],
		});

		const result = useServerStore.getState().messagesMap[1];
		expect(result?.map((m) => m.id)).toEqual([1, 2]);
	});

	it('caps live appends at MAX_MESSAGES_PER_CHANNEL by evicting oldest', () => {
		const store = useServerStore.getState();
		const seed: TJoinedMessage[] = [];
		for (let i = 0; i < 1000; i++) {
			seed.push(createMessage(i + 1, i + 1));
		}
		store.addMessages({ channelId: 1, messages: seed });

		store.addMessages({
			channelId: 1,
			messages: [createMessage(2000, 5000), createMessage(2001, 5001)],
		});

		const result = useServerStore.getState().messagesMap[1];
		expect(result?.length).toBe(1000);
		expect(result?.[0]?.id).toBe(3);
		expect(result?.[result.length - 1]?.id).toBe(2001);
	});

	it('does not cap prepends so loaded older messages stay visible', () => {
		const store = useServerStore.getState();
		const seed: TJoinedMessage[] = [];
		for (let i = 0; i < 1000; i++) {
			seed.push(createMessage(i + 1000, i + 1000));
		}
		store.addMessages({ channelId: 1, messages: seed });

		store.addMessages({
			channelId: 1,
			messages: [createMessage(1, 1), createMessage(2, 2)],
			opts: { prepend: true },
		});

		const result = useServerStore.getState().messagesMap[1];
		expect(result?.length).toBe(1002);
		expect(result?.[0]?.id).toBe(1);
	});

	it('preserves prepended history when later live messages are appended', () => {
		const store = useServerStore.getState();
		const seed: TJoinedMessage[] = [];
		for (let i = 0; i < 1000; i++) {
			seed.push(createMessage(i + 1000, i + 1000));
		}
		store.addMessages({ channelId: 1, messages: seed });

		store.addMessages({
			channelId: 1,
			messages: [createMessage(1, 1), createMessage(2, 2)],
			opts: { prepend: true },
		});
		store.addMessages({
			channelId: 1,
			messages: [createMessage(2000, 2000), createMessage(2001, 2001)],
		});

		const result = useServerStore.getState().messagesMap[1];
		expect(result?.length).toBe(1002);
		expect(result?.slice(0, 4).map((m) => m.id)).toEqual([1, 2, 1002, 1003]);
		expect(result?.[result.length - 1]?.id).toBe(2001);
	});

	it('decrements the protected prefix when a prepended message is deleted', () => {
		const store = useServerStore.getState();
		const seed: TJoinedMessage[] = [];
		for (let i = 0; i < 1000; i++) {
			seed.push(createMessage(i + 1000, i + 1000));
		}
		store.addMessages({ channelId: 1, messages: seed });

		store.addMessages({
			channelId: 1,
			messages: [createMessage(1, 1), createMessage(2, 2)],
			opts: { prepend: true },
		});

		store.deleteMessage({ channelId: 1, messageId: 1 });
		store.addMessages({
			channelId: 1,
			messages: [createMessage(2000, 2000), createMessage(2001, 2001)],
		});

		const result = useServerStore.getState().messagesMap[1];
		expect(result?.length).toBe(1001);
		expect(result?.slice(0, 3).map((m) => m.id)).toEqual([2, 1002, 1003]);
		expect(result?.[result.length - 1]?.id).toBe(2001);
	});
});
