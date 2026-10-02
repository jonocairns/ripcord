import { describe, expect, it, mock } from 'bun:test';
import { createFileAccessRefresher, type TFileAccessTokensClient } from '../file-access-refresher';
import type { TFileAccessToken } from '../file-access-tokens';

type TQueryInput = { fileIds: number[] };

const signAll = async ({ fileIds }: TQueryInput) => fileIds.map((fileId) => ({ fileId, accessToken: `new-${fileId}` }));

// A refresher that records every batch of tokens it applies.
const setup = (query: (input: TQueryInput) => Promise<TFileAccessToken[]>) => {
	let serverId: string | undefined = 'server-a';
	const applied: TFileAccessToken[][] = [];
	const onError = mock((_error: unknown) => {});
	const queryMock = mock(query);
	const client: TFileAccessTokensClient = { files: { refreshAccessTokens: { query: queryMock } } };
	const refresher = createFileAccessRefresher({
		getClient: () => client,
		getServerId: () => serverId,
		applyTokens: (tokens) => applied.push(tokens),
		onError,
	});

	return {
		refresher,
		queryMock,
		applied,
		onError,
		switchServer: (nextServerId: string | undefined) => {
			serverId = nextServerId;
		},
	};
};

// A query that resolves only when the test says so.
const controlledQuery = () => {
	const pending: Array<() => void> = [];
	const query = (input: TQueryInput) =>
		new Promise<TFileAccessToken[]>((resolve) => {
			pending.push(() => resolve(input.fileIds.map((fileId) => ({ fileId, accessToken: `new-${fileId}` }))));
		});

	return { query, resolveNext: () => pending.shift()?.() };
};

describe('createFileAccessRefresher', () => {
	it('requests the given files across channels in batches of 100', async () => {
		const fileIds = Array.from({ length: 150 }, (_, index) => index + 1);
		const { refresher, queryMock, applied } = setup(signAll);

		await refresher.refreshFiles(fileIds);

		expect(queryMock.mock.calls.map(([input]) => input.fileIds.length)).toEqual([100, 50]);
		expect(applied.flat().map(({ fileId }) => fileId)).toEqual(fileIds);
	});

	it('makes no request when there is nothing to refresh', async () => {
		const { refresher, queryMock } = setup(signAll);

		await refresher.refreshFiles([]);

		expect(queryMock).not.toHaveBeenCalled();
	});

	it('applies nothing when the request fails or the route is missing', async () => {
		const { refresher, applied, onError } = setup(async () => {
			throw new Error('No procedure found on path "files.refreshAccessTokens"');
		});

		await refresher.refreshFiles([1, 2]);

		expect(applied).toEqual([]);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it('keeps earlier batches when a later batch fails', async () => {
		let calls = 0;
		const { refresher, applied } = setup(async (input) => {
			calls += 1;
			if (calls === 2) throw new Error('socket closed');
			return signAll(input);
		});

		await refresher.refreshFiles(Array.from({ length: 150 }, (_, index) => index + 1));

		// The first request's tokens are valid on their own; the failed request's
		// files keep their old tokens for the next trigger.
		expect(applied).toHaveLength(1);
		expect(applied[0]).toHaveLength(100);
	});

	it('drops a response that lands after the client moved to another server', async () => {
		const { query, resolveNext } = controlledQuery();
		const { refresher, applied, switchServer } = setup(query);

		const refresh = refresher.refreshFiles([1]);

		switchServer('server-b');
		resolveNext();
		await refresh;

		expect(applied).toEqual([]);
	});

	it('requests a file again when asked while its request is in flight', async () => {
		const { query, resolveNext } = controlledQuery();
		const { refresher, queryMock } = setup(query);

		const first = refresher.refreshFiles([1, 2]);
		// A rotation event and a media failure arrive mid-flight; they collapse
		// into one follow-up request.
		const second = refresher.refreshFiles([1]);
		const third = refresher.refreshFiles([1, 3]);

		expect(queryMock).toHaveBeenCalledTimes(1);

		resolveNext();
		await Bun.sleep(0);

		expect(queryMock).toHaveBeenCalledTimes(2);
		expect(queryMock.mock.calls[1]?.[0]).toEqual({ fileIds: [1, 3] });

		resolveNext();
		await Promise.all([first, second, third]);

		expect(queryMock).toHaveBeenCalledTimes(2);
	});
});
