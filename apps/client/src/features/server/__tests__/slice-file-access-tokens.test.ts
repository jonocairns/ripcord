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
				1: [createMessage(1, 1, [createFile(1, 'old-1'), createFile(2, 'old-2')])],
				2: [createMessage(2, 2, [createFile(3, 'old-3')])],
				3: [createMessage(3, 3, [createFile(4, 'old-4')])],
			},
		});
	});

	it('sets returned tokens wherever the file is loaded and leaves the rest', () => {
		const untouchedChannel = useServerStore.getState().messagesMap[3];

		useServerStore.getState().setFileAccessTokens({
			tokens: [
				{ fileId: 1, accessToken: 'new-1' },
				{ fileId: 3, accessToken: 'new-3' },
			],
		});

		const { messagesMap } = useServerStore.getState();

		expect(messagesMap[1]?.[0]?.files.map((file) => file._accessToken)).toEqual(['new-1', 'old-2']);
		expect(messagesMap[2]?.[0]?.files[0]?._accessToken).toBe('new-3');
		expect(messagesMap[3]).toBe(untouchedChannel);
	});

	it('keeps the store unchanged when no token differs', () => {
		const before = useServerStore.getState().messagesMap;

		useServerStore.getState().setFileAccessTokens({
			tokens: [
				{ fileId: 1, accessToken: 'old-1' },
				{ fileId: 99, accessToken: 'unknown' },
			],
		});

		expect(useServerStore.getState().messagesMap).toBe(before);
	});
});
