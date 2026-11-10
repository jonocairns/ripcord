import { beforeEach, describe, expect, it } from 'bun:test';
import type { TJoinedMessage } from '@sharkord/shared';
import { useServerStore } from '../../slice';
import { sortLatestMessagePage } from '../latest-message-page';
import { loadMessagePage } from '../load-message-page';

describe('latest page ordering', () => {
	it('sorts timestamp ties by id deterministically', () => {
		expect(
			sortLatestMessagePage([
				{ id: 2, createdAt: 1 },
				{ id: 1, createdAt: 1 },
			]).map((m) => m.id),
		).toEqual([1, 2]);
	});
});

const joinedMessage = (id: number): TJoinedMessage => ({
	id,
	channelId: 1,
	userId: 1,
	content: `message ${id}`,
	createdAt: id,
	editable: true,
	metadata: null,
	updatedAt: null,
	files: [],
	reactions: [],
});

describe('latest page in the message store', () => {
	beforeEach(() => useServerStore.getState().resetState());

	it('clears the protected prefix on replacement and caps the new tail', () => {
		useServerStore.setState({
			messagesMap: { 1: [joinedMessage(1)] },
			protectedMessagePrefixCounts: { 1: 1 },
		});
		useServerStore.getState().applyLatestMessagePage({
			channelId: 1,
			messages: Array.from({ length: 1005 }, (_, index) => joinedMessage(index + 10)),
		});
		expect(useServerStore.getState().protectedMessagePrefixCounts[1]).toBeUndefined();
		expect(useServerStore.getState().messagesMap[1]).toHaveLength(1000);
		expect(useServerStore.getState().messagesMap[1]?.[0]?.id).toBe(15);
	});

	it('resets protected history even for an overlap', () => {
		useServerStore.setState({
			messagesMap: { 1: [joinedMessage(1), joinedMessage(2)] },
			protectedMessagePrefixCounts: { 1: 2 },
		});
		useServerStore.getState().applyLatestMessagePage({ channelId: 1, messages: [joinedMessage(2), joinedMessage(3)] });
		expect(useServerStore.getState().protectedMessagePrefixCounts[1]).toBeUndefined();
		expect(useServerStore.getState().messagesMap[1]).toEqual([joinedMessage(2), joinedMessage(3)]);
	});

	it('applies duplicate first-page messages as authoritative and refreshes their invalidated files', async () => {
		const loaded = joinedMessage(1);
		useServerStore.setState({ messagesMap: { 1: [loaded] } });
		let version = 'before';
		let refreshes = 0;
		const pageMessage = {
			...loaded,
			content: 'edited',
			files: [
				{
					id: 1,
					name: 'file',
					originalName: 'file',
					extension: 'txt',
					mimeType: 'text/plain',
					md5: 'hash',
					size: 1,
					userId: 1,
					createdAt: 1,
					updatedAt: null,
				},
			],
		};
		const cursor = await loadMessagePage({
			query: async () => {
				version = 'after';
				return { messages: [pageMessage], nextCursor: null };
			},
			getLoadedMessages: () => useServerStore.getState().messagesMap[1] ?? [],
			getFileLinkVersion: () => version,
			applyLatestMessagePage: (messages) => {
				useServerStore.getState().applyLatestMessagePage({ channelId: 1, messages });
			},
			addMessages: () => {
				throw new Error('First pages must use the authoritative action');
			},
			refreshFileAccessTokens: async () => {
				refreshes += 1;
			},
		});
		expect(cursor).toBeNull();
		expect(useServerStore.getState().messagesMap[1]).toEqual([pageMessage]);
		expect(refreshes).toBe(1);
	});
});
