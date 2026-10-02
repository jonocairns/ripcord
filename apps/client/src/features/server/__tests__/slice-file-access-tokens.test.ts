import { beforeEach, describe, expect, it } from 'bun:test';
import type { TFile, TJoinedMessage } from '@sharkord/shared';
import { useServerStore } from '../slice';

const createFile = (id: number, accessToken?: string): TFile =>
	({
		id,
		name: `file-${id}.txt`,
		...(accessToken !== undefined ? { _accessToken: accessToken } : {}),
	}) as unknown as TFile;

const createMessage = (id: number, channelId: number, files: TFile[]): TJoinedMessage =>
	({
		id,
		channelId,
		userId: 1,
		content: '',
		createdAt: id,
		updatedAt: id,
		files,
		reactions: [],
	}) as unknown as TJoinedMessage;

describe('useServerStore.setFileAccessTokens', () => {
	beforeEach(() => {
		useServerStore.setState({
			messagesMap: {
				1: [createMessage(1, 1, [createFile(1, 'old-1'), createFile(2, 'old-2'), createFile(3, 'old-3')])],
				2: [createMessage(2, 2, [createFile(1, 'other-channel')])],
			},
		});
	});

	it('touches only requested files in the named channel', () => {
		const otherChannel = useServerStore.getState().messagesMap[2];

		useServerStore.getState().setFileAccessTokens({
			channelId: 1,
			requestedFileIds: [1, 2],
			tokens: [{ fileId: 1, accessToken: 'new-1' }],
		});

		const [message] = useServerStore.getState().messagesMap[1] ?? [];

		expect(message?.files[0]?._accessToken).toBe('new-1');
		// Requested but left out of the response: the channel went public.
		expect(message?.files[1]).not.toHaveProperty('_accessToken');
		// Not requested: keeps its token.
		expect(message?.files[2]?._accessToken).toBe('old-3');
		expect(useServerStore.getState().messagesMap[2]).toBe(otherChannel);
	});

	it('ignores a channel with no loaded messages', () => {
		const before = useServerStore.getState().messagesMap;

		useServerStore.getState().setFileAccessTokens({
			channelId: 3,
			requestedFileIds: [1],
			tokens: [{ fileId: 1, accessToken: 'new-1' }],
		});

		expect(useServerStore.getState().messagesMap).toBe(before);
	});
});
