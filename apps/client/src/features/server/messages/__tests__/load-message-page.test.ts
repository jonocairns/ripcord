import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { TFile, TJoinedMessage } from '@sharkord/shared';
import { getFileLinkVersion } from '../../nonce-signals';
import { useServerStore } from '../../slice';
import { createFileAccessRefresher } from '../file-access-refresher';
import { getFileIds, getLoadedFiles } from '../file-access-tokens';
import { loadMessagePage } from '../load-message-page';

const createFile = (id: number, accessToken = 'old-token'): TFile => ({
	id,
	name: `file-${id}.pdf`,
	originalName: `file-${id}.pdf`,
	extension: 'pdf',
	mimeType: 'application/pdf',
	md5: 'hash',
	size: 1,
	userId: 1,
	createdAt: id,
	updatedAt: null,
	_accessToken: accessToken,
});

const createMessage = (id: number, files: TFile[] = []): TJoinedMessage => ({
	id,
	channelId: 1,
	userId: 1,
	content: '',
	editable: true,
	metadata: null,
	createdAt: id,
	updatedAt: null,
	files,
	reactions: [],
});

const setup = (prepend = false) => {
	let resolvePage: (page: { messages: TJoinedMessage[]; nextCursor: number | null }) => void = () => {};
	let rejectPage: (error: Error) => void = () => {};
	const page = new Promise<{ messages: TJoinedMessage[]; nextCursor: number | null }>((resolve, reject) => {
		resolvePage = resolve;
		rejectPage = reject;
	});
	const queryTokens = mock(async ({ fileIds }: { fileIds: number[] }) =>
		fileIds.map((fileId) => ({ fileId, accessToken: 'new-token' })),
	);
	const refresher = createFileAccessRefresher({
		getClient: () => ({ files: { refreshAccessTokens: { query: queryTokens } } }),
		getServerId: () => useServerStore.getState().serverId,
		applyTokens: (tokens) => useServerStore.getState().setFileAccessTokens({ tokens }),
	});
	let refresh = Promise.resolve();
	const refreshFileAccessTokens = () => {
		refresh = refresher.refreshFiles(getFileIds(getLoadedFiles(useServerStore.getState().messagesMap)));
		return refresh;
	};
	const load = () =>
		loadMessagePage({
			query: () => page,
			getLoadedMessages: () => useServerStore.getState().messagesMap[1] ?? [],
			getFileLinkVersion,
			addMessages: (messages) => useServerStore.getState().addMessages({ channelId: 1, messages, opts: { prepend } }),
			refreshFileAccessTokens,
		});

	return { load, resolvePage, rejectPage, queryTokens, refreshFileAccessTokens, waitForRefresh: () => refresh };
};

describe('loadMessagePage', () => {
	beforeEach(() => {
		useServerStore.getState().resetState();
	});

	for (const invalidation of ['rotation', 'rejoin'] as const) {
		it(`refreshes attachments arriving after an in-flight ${invalidation}`, async () => {
			const { load, resolvePage, queryTokens, refreshFileAccessTokens, waitForRefresh } = setup();
			const loading = load();

			if (invalidation === 'rotation') useServerStore.getState().bumpFileAccessChangeNonce();
			else useServerStore.getState().bumpServerRejoinNonce();

			// The event's refresh finishes before the page arrives and cannot see its files.
			await refreshFileAccessTokens();
			expect(queryTokens).not.toHaveBeenCalled();

			resolvePage({ messages: [createMessage(1, [createFile(11)])], nextCursor: null });
			await loading;
			await waitForRefresh();

			expect(queryTokens).toHaveBeenCalledWith({ fileIds: [11] });
			expect(useServerStore.getState().messagesMap[1]?.[0]?.files[0]?._accessToken).toBe('new-token');
		});
	}

	it('preserves freshly loaded duplicates while prepending an older page', async () => {
		const { load, resolvePage, waitForRefresh } = setup(true);
		const loading = load();
		const currentMessage = createMessage(3, [createFile(13, 'new-token')]);

		useServerStore.getState().addMessages({ channelId: 1, messages: [currentMessage] });
		useServerStore.getState().bumpFileAccessChangeNonce();
		resolvePage({
			messages: [createMessage(3, [createFile(13)]), createMessage(2, [createFile(12)]), createMessage(1)],
			nextCursor: 10,
		});

		expect(await loading).toBe(10);
		await waitForRefresh();

		const messages = useServerStore.getState().messagesMap[1] ?? [];
		expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
		expect(messages[2]).toBe(currentMessage);
		expect(messages[1]?.files[0]?._accessToken).toBe('new-token');
	});

	it('does not refresh when invalidation preceded the request', async () => {
		useServerStore.getState().bumpFileAccessChangeNonce();
		const { load, resolvePage, queryTokens } = setup();
		const loading = load();

		resolvePage({ messages: [createMessage(1, [createFile(11, 'new-token')])], nextCursor: null });
		await loading;

		expect(queryTokens).not.toHaveBeenCalled();
	});

	it('does not refresh an invalidated page without new attachments', async () => {
		const { load, resolvePage, queryTokens } = setup();
		const loading = load();

		useServerStore.getState().bumpFileAccessChangeNonce();
		resolvePage({ messages: [createMessage(1)], nextCursor: null });
		await loading;

		expect(queryTokens).not.toHaveBeenCalled();
	});

	it('leaves messages unchanged when the page request fails', async () => {
		const { load, rejectPage, queryTokens } = setup();
		const loading = load();
		const before = useServerStore.getState().messagesMap;

		useServerStore.getState().bumpFileAccessChangeNonce();
		rejectPage(new Error('socket closed'));

		await expect(loading).rejects.toThrow('socket closed');
		expect(useServerStore.getState().messagesMap).toBe(before);
		expect(queryTokens).not.toHaveBeenCalled();
	});
});
