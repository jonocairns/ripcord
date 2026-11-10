import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { TJoinedMessage } from '@sharkord/shared';
import { useServerStore } from '../../slice';
import { createMessagePageLoader } from '../message-page-loader';

let actions: typeof import('../actions');
beforeAll(async () => {
	// Keep browser/audio and network initialization outside these store/request tests.
	mock.module('../../sounds/actions', () => ({ playSound: () => {} }));
	mock.module('@/lib/trpc', () => ({
		getWsClientInstanceId: () => undefined,
		waitForTRPCSessionAuthentication: async () => {},
		getTRPCClient: () => {
			throw new Error('Unexpected network access');
		},
	}));
	actions = await import('../actions');
});
afterAll(() => mock.restore());

const message = (id: number, content = `${id}`): TJoinedMessage => ({
	id,
	content,
	createdAt: id,
	channelId: 1,
	userId: 1,
	editable: true,
	metadata: null,
	updatedAt: null,
	files: [],
	reactions: [],
});
const deferred = <T>() => {
	let resolve: (value: T) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
const setup = () => {
	let session = {
		channelId: 1,
		messageSession: 1,
		connected: true,
		serverId: 'server-1',
		nonce: 1,
		client: {},
		socketOpen: true,
	};
	let cursor: number | null = 1;
	let fetching = false;
	let loading = true;
	let hasMore = true;
	const errors: unknown[] = [];
	let response = deferred<{ messages: TJoinedMessage[]; nextCursor: number | null }>();
	let queries = 0;
	const cursors: (number | null)[] = [];
	const loader = createMessagePageLoader({
		channelId: 1,
		getSession: () => session,
		query: (cursor) => {
			cursors.push(cursor);
			queries += 1;
			return response.promise;
		},
		getLoadedMessages: () => useServerStore.getState().messagesMap[1] ?? [],
		getFileLinkVersion: () => 'same',
		applyLatestMessagePage: (page) => actions.applyLatestMessagePage(1, page),
		addMessages: (page, prepend) => actions.addMessages(1, page, { prepend }),
		refreshFileAccessTokens: async () => {},
		setCursor: (value) => {
			cursor = value;
		},
		setFetching: (value) => {
			fetching = value;
		},
		setLoading: (value) => {
			loading = value;
		},
		setHasMore: (value) => {
			hasMore = value;
		},
		onError: (error) => {
			errors.push(error);
		},
	});
	const start = (reconcile = true) => {
		response = deferred();
		return { response, done: loader.fetch(reconcile ? null : cursor, 20, reconcile) };
	};
	return {
		start,
		nextResponse: () => {
			response = deferred();
			return response;
		},
		cursors,
		requests: loader,
		unsubscribe: loader.invalidate,
		endSession: () => {
			session = { ...session, messageSession: session.messageSession + 1 };
		},
		changeSession: (changes: Partial<typeof session>) => {
			session = { ...session, ...changes };
		},
		cursor: () => cursor,
		fetching: () => fetching,
		loading: () => loading,
		hasMore: () => hasMore,
		queries: () => queries,
		errors,
	};
};
// This is the same action invoked by subscribeToMessageEvents for NEW_MESSAGE.
const insert = (row: TJoinedMessage) => actions.addMessages(1, [row], {}, true);

describe('deferred reconnect page reconciliation', () => {
	beforeEach(() => {
		useServerStore.getState().resetState();
		useServerStore.setState({ ownUserId: 1 });
	});
	it('replays append, edit, delete and reaction rows in arrival order over the full raw page', async () => {
		const h = setup();
		const load = h.start();
		const edited = message(1, 'live edit');
		const reaction = {
			...message(2),
			reactions: [{ file: null, fileId: null, messageId: 2, userId: 1, emoji: '👍', createdAt: 1 }],
		};
		insert(message(4));
		actions.updateMessage(1, message(100, 'old history edit'));
		actions.updateMessage(1, edited);
		actions.deleteMessage(1, 3);
		actions.updateMessage(1, reaction);
		load.response.resolve({ messages: [message(3), message(2), message(1)], nextCursor: 99 });
		await load.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([edited, reaction, message(4)]);
		expect(h.cursor()).toBe(99);
		expect(h.hasMore()).toBe(true);
		expect(h.loading()).toBe(false);
		expect(h.fetching()).toBe(false);
		h.unsubscribe();
	});
	it('loads older history when live deletes empty the latest page', async () => {
		const h = setup();
		insert(message(1));
		const load = h.start();
		actions.deleteMessage(1, 3);
		const older = h.nextResponse();
		load.response.resolve({ messages: [message(3)], nextCursor: 3 });
		await Promise.resolve();
		await Promise.resolve();
		expect(h.cursors).toEqual([null, 3]);
		expect(h.fetching()).toBe(true);
		// Keep replaying the same journal, including mutations during follow-up.
		actions.deleteMessage(1, 2);
		insert(message(4));
		older.resolve({ messages: [message(2), message(1)], nextCursor: null });
		await load.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([message(1), message(4)]);
		expect(h.cursor()).toBeNull();
		expect(h.hasMore()).toBe(false);
		expect(h.fetching()).toBe(false);
		h.unsubscribe();
	});
	it('bounds empty-page follow-ups and retains a usable older cursor', async () => {
		const h = setup();
		const load = h.start();
		let response = load.response;
		for (const id of [5, 4, 3, 2]) {
			actions.deleteMessage(1, id);
			const next = h.nextResponse();
			response.resolve({ messages: [message(id)], nextCursor: id });
			await Promise.resolve();
			await Promise.resolve();
			response = next;
		}
		await load.done;
		expect(h.cursors).toEqual([null, 5, 4, 3]);
		expect(h.cursor()).toBe(2);
		expect(h.hasMore()).toBe(true);
		expect(h.fetching()).toBe(false);
		expect(useServerStore.getState().messagesMap[1]).toEqual([]);
		const manual = h.start(false);
		expect(h.cursors).toEqual([null, 5, 4, 3, 2]);
		manual.response.resolve({ messages: [message(1)], nextCursor: null });
		await manual.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([message(1)]);
		h.unsubscribe();
	});
	it('retains the older cursor for retry when a follow-up fails', async () => {
		const h = setup();
		const load = h.start();
		actions.deleteMessage(1, 3);
		const older = h.nextResponse();
		load.response.resolve({ messages: [message(3)], nextCursor: 3 });
		await Promise.resolve();
		await Promise.resolve();
		const error = new Error('follow-up failed');
		older.reject(error);
		await load.done;
		expect(h.cursor()).toBe(3);
		expect(h.hasMore()).toBe(true);
		expect(h.fetching()).toBe(false);
		expect(h.errors).toEqual([error]);
		const retry = h.start(false);
		expect(h.cursors).toEqual([null, 3, 3]);
		retry.response.resolve({ messages: [message(1)], nextCursor: null });
		await retry.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([message(1)]);
		h.unsubscribe();
	});
	it('keeps an empty terminal page empty without fetching again', async () => {
		const h = setup();
		insert(message(1));
		const load = h.start();
		actions.deleteMessage(1, 3);
		load.response.resolve({ messages: [message(3)], nextCursor: null });
		await load.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([]);
		expect(h.queries()).toBe(1);
		expect(h.hasMore()).toBe(false);
		h.unsubscribe();
	});
	it.each(['replacement', 'session', 'teardown'])('discards an obsolete follow-up after %s', async (reason) => {
		const h = setup();
		const load = h.start();
		actions.deleteMessage(1, 3);
		const older = h.nextResponse();
		load.response.resolve({ messages: [message(3)], nextCursor: 3 });
		await Promise.resolve();
		await Promise.resolve();
		expect(h.cursors).toEqual([null, 3]);
		if (reason === 'replacement') {
			const latest = h.start();
			latest.response.resolve({ messages: [message(9)], nextCursor: 9 });
			await latest.done;
		} else if (reason === 'session') h.endSession();
		else h.requests.invalidate();
		const messages = useServerStore.getState().messagesMap[1];
		const cursor = h.cursor();
		const fetching = h.fetching();
		older.resolve({ messages: [message(1)], nextCursor: null });
		await load.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual(messages);
		expect(h.cursor()).toBe(cursor);
		expect(h.fetching()).toBe(fetching);
		h.unsubscribe();
	});
	it('fences overlapping reloads including stale failure/finally and preserves the newest journal', async () => {
		const h = setup();
		const old = h.start();
		const latest = h.start();
		old.response.reject(new Error('obsolete'));
		await old.done;
		expect(h.fetching()).toBe(true);
		expect(h.loading()).toBe(true);
		expect(h.errors).toEqual([]);
		insert(message(3));
		latest.response.resolve({ messages: [message(2)], nextCursor: 2 });
		await latest.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([message(2), message(3)]);
		const older = h.start();
		const newer = h.start();
		newer.response.resolve({ messages: [message(6)], nextCursor: 6 });
		await newer.done;
		older.response.resolve({ messages: [message(5)], nextCursor: 5 });
		await older.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([message(6)]);
		expect(h.cursor()).toBe(6);
		h.unsubscribe();
	});
	it.each(['teardown', 'session'])('discards late results after %s', async (reason) => {
		const h = setup();
		const load = h.start();
		if (reason === 'teardown') h.requests.invalidate();
		else h.endSession();
		load.response.resolve({ messages: [message(1)], nextCursor: null });
		await load.done;
		expect(useServerStore.getState().messagesMap[1]).toBeUndefined();
		expect(h.cursor()).toBe(1);
		h.unsubscribe();
	});
	it('allows a fresh mount load after effect cleanup invalidates a pending load', async () => {
		const h = setup();
		const old = h.start(false);
		h.requests.invalidate();
		const fresh = h.start(false);
		expect(h.queries()).toBe(2);
		old.response.resolve({ messages: [message(1)], nextCursor: 1 });
		await old.done;
		expect(h.fetching()).toBe(true);
		fresh.response.resolve({ messages: [message(2)], nextCursor: null });
		await fresh.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([message(2)]);
		expect(h.cursor()).toBeNull();
		expect(h.hasMore()).toBe(false);
		expect(h.fetching()).toBe(false);
		h.unsubscribe();
	});
	it('blocks older-page loading immediately while a reconnect reload is in flight', async () => {
		const h = setup();
		const reload = h.start();
		const older = h.start(false);
		await older.done;
		expect(h.queries()).toBe(1);
		reload.response.resolve({ messages: [message(60)], nextCursor: 60 });
		await reload.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([message(60)]);
		expect(h.cursor()).toBe(60);
		expect(h.fetching()).toBe(false);
		h.unsubscribe();
	});
	it.each([
		{ channelId: 2 },
		{ serverId: 'server-2' },
		{ connected: false },
		{ nonce: 2 },
		{ client: {} },
		{ socketOpen: false },
	])('discards responses when session identity changes: %j', async (changes) => {
		const h = setup();
		const load = h.start();
		h.changeSession(changes);
		load.response.resolve({ messages: [message(1)], nextCursor: null });
		await load.done;
		expect(useServerStore.getState().messagesMap[1]).toBeUndefined();
		expect(h.cursor()).toBe(1);
		expect(h.fetching()).toBe(true);
		expect(h.loading()).toBe(true);
		expect(h.hasMore()).toBe(true);
		h.unsubscribe();
	});
	it('retries after failure on the next bump', async () => {
		const h = setup();
		const failed = h.start();
		failed.response.reject(new Error('offline'));
		await failed.done;
		expect(h.fetching()).toBe(false);
		const retry = h.start();
		retry.response.resolve({ messages: [message(30)], nextCursor: 30 });
		await retry.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([message(30)]);
		h.unsubscribe();
	});
	it.each([
		{ page: [] },
		{ page: Array.from({ length: 20 }, (_, i) => message(60 - i)) },
		{ page: Array.from({ length: 20 }, (_, i) => message(100 - i)) },
	])('replaces an inactive or discontinuous cache and its old cursor', async ({ page }) => {
		const h = setup();
		useServerStore.setState({
			messagesMap: { 1: [...Array.from({ length: 20 }, (_, i) => message(i + 1)), message(41)] },
			protectedMessagePrefixCounts: { 1: 10 },
		});
		const load = h.start();
		load.response.resolve({ messages: [...page], nextCursor: page.at(-1)?.createdAt ?? null });
		await load.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([...page].reverse());
		expect(useServerStore.getState().protectedMessagePrefixCounts[1]).toBeUndefined();
		expect(h.cursor()).toBe(page.at(-1)?.createdAt ?? null);
		h.unsubscribe();
	});
});
