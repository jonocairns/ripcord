import { describe, expect, it, mock } from 'bun:test';
import type { TFile, TJoinedMessage } from '@sharkord/shared';
import type { TMessagesMap } from '../../types';
import { createFileAccessRefresher, type TFileAccessTokensClient } from '../file-access-refresher';
import { applyFileAccessTokens, type TFileAccessToken } from '../file-access-tokens';

type TQueryInput = { channelId: number; fileIds: number[] };

const createFile = (id: number, accessToken?: string): TFile =>
	({
		id,
		name: `file-${id}.txt`,
		...(accessToken !== undefined ? { _accessToken: accessToken } : {}),
	}) as unknown as TFile;

const createMessage = (id: number, files: TFile[]): TJoinedMessage =>
	({ id, files, reactions: [], content: '', createdAt: id }) as unknown as TJoinedMessage;

// A refresher over an in-memory messages map that applies tokens like the store.
const setup = (initialMessagesMap: TMessagesMap, query: (input: TQueryInput) => Promise<TFileAccessToken[]>) => {
	let messagesMap = initialMessagesMap;
	let serverId: string | undefined = 'server-a';
	const queryMock = mock(query);
	const client: TFileAccessTokensClient = { files: { getAccessTokens: { query: queryMock } } };
	const refresher = createFileAccessRefresher({
		getClient: () => client,
		getServerId: () => serverId,
		getMessagesMap: () => messagesMap,
		setFileAccessTokens: (channelId, requestedFileIds, tokens) => {
			const messages = messagesMap[channelId];

			if (!messages) return;

			messagesMap = { ...messagesMap, [channelId]: applyFileAccessTokens(messages, requestedFileIds, tokens) };
		},
	});

	return {
		refresher,
		queryMock,
		getMessagesMap: () => messagesMap,
		switchServer: (nextServerId: string | undefined, nextMessagesMap: TMessagesMap) => {
			serverId = nextServerId;
			messagesMap = nextMessagesMap;
		},
	};
};

const signAll = async ({ fileIds }: TQueryInput) => fileIds.map((fileId) => ({ fileId, accessToken: `new-${fileId}` }));

describe('createFileAccessRefresher', () => {
	it('sends every loaded file ID in the channel, tokened or not', async () => {
		const { refresher, queryMock, getMessagesMap } = setup(
			{ 1: [createMessage(1, [createFile(1, 'old-1'), createFile(2)]), createMessage(2, [createFile(3)])] },
			signAll,
		);

		await refresher.refreshChannel(1);

		expect(queryMock.mock.calls).toEqual([[{ channelId: 1, fileIds: [1, 2, 3] }]]);
		expect(getMessagesMap()[1]?.flatMap((message) => message.files.map((file) => file._accessToken))).toEqual([
			'new-1',
			'new-2',
			'new-3',
		]);
	});

	it('requests at most 100 file IDs per call', async () => {
		const files = Array.from({ length: 150 }, (_, index) => createFile(index + 1));
		const { refresher, queryMock } = setup({ 1: [createMessage(1, files)] }, signAll);

		await refresher.refreshChannel(1);

		expect(queryMock.mock.calls.map(([input]) => input.fileIds.length)).toEqual([100, 50]);
	});

	it('leaves the store unchanged when the request fails or the route is missing', async () => {
		const initialMessagesMap = { 1: [createMessage(1, [createFile(1, 'old-1'), createFile(2)])] };
		const { refresher, getMessagesMap } = setup(initialMessagesMap, async () => {
			throw new Error('No procedure found on path "files.getAccessTokens"');
		});

		await refresher.refreshChannel(1);

		expect(getMessagesMap()).toBe(initialMessagesMap);
	});

	it('keeps earlier batches when a later batch fails', async () => {
		const files = Array.from({ length: 150 }, (_, index) => createFile(index + 1, 'old'));
		let calls = 0;
		const { refresher, getMessagesMap } = setup({ 1: [createMessage(1, files)] }, async (input) => {
			calls += 1;
			if (calls === 2) throw new Error('socket closed');
			return signAll(input);
		});

		await refresher.refreshChannel(1);

		const tokens = getMessagesMap()[1]?.[0]?.files.map((file) => file._accessToken) ?? [];

		// The first request's tokens are valid on their own; the failed request's
		// files keep their old tokens for the next trigger.
		expect(tokens.slice(0, 100).every((token, index) => token === `new-${index + 1}`)).toBe(true);
		expect(tokens.slice(100).every((token) => token === 'old')).toBe(true);
	});

	it('drops a response that lands after the client moved to another server', async () => {
		let resolveQuery: () => void = () => {};
		const { refresher, queryMock, getMessagesMap, switchServer } = setup(
			{ 1: [createMessage(1, [createFile(1, 'server-a-token')])] },
			(input) =>
				new Promise((resolve) => {
					resolveQuery = () => resolve(input.fileIds.map((fileId) => ({ fileId, accessToken: 'server-a-new' })));
				}),
		);
		// Same channel and file IDs on the next server.
		const nextServerMessages = { 1: [createMessage(1, [createFile(1, 'server-b-token')])] };

		const refresh = refresher.refreshChannel(1);

		switchServer('server-b', nextServerMessages);
		resolveQuery();
		await refresh;

		expect(queryMock).toHaveBeenCalledTimes(1);
		expect(getMessagesMap()).toBe(nextServerMessages);
	});

	it('makes no request for a channel with no loaded messages', async () => {
		const { refresher, queryMock } = setup({ 1: [createMessage(1, [createFile(1)])] }, signAll);

		await refresher.refreshChannel(2);

		expect(queryMock).not.toHaveBeenCalled();
	});

	it('refreshes every channel with loaded files, and skips channels with none', async () => {
		const { refresher, queryMock } = setup(
			{
				1: [createMessage(1, [createFile(1)])],
				2: [],
				3: [createMessage(2, [])],
				4: [createMessage(3, [createFile(4, 'old-4')])],
			},
			signAll,
		);

		await refresher.refreshLoadedChannels();

		expect(queryMock.mock.calls.map(([input]) => input.channelId).sort()).toEqual([1, 4]);
	});

	it('runs once more after an in-flight refresh when asked again', async () => {
		const pending: Array<() => void> = [];
		const { refresher, queryMock } = setup({ 1: [createMessage(1, [createFile(1)])] }, (input) => {
			return new Promise((resolve) => {
				pending.push(() => resolve(input.fileIds.map((fileId) => ({ fileId, accessToken: 'token' }))));
			});
		});

		const first = refresher.refreshChannel(1);
		// Both arrive while the first request is in flight (e.g. a rotation event
		// and a media failure); they collapse into one follow-up request.
		const second = refresher.refreshChannel(1);
		const third = refresher.refreshChannel(1);

		expect(queryMock).toHaveBeenCalledTimes(1);

		pending.shift()?.();
		await Bun.sleep(0);

		expect(queryMock).toHaveBeenCalledTimes(2);

		pending.shift()?.();
		await Promise.all([first, second, third]);

		expect(queryMock).toHaveBeenCalledTimes(2);
	});
});
