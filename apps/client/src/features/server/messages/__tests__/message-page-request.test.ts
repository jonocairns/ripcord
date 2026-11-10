import { beforeEach, describe, expect, it } from 'bun:test';
import type { TJoinedMessage } from '@sharkord/shared';
import { useServerStore } from '../../slice';
import { loadMessagePage } from '../load-message-page';
import { createMessagePageRequest, recordMessageMutation, subscribeToMessageMutations } from '../message-page-request';

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
	const requests = createMessagePageRequest();
	const unsubscribe = subscribeToMessageMutations((channelId, mutation) => {
		if (channelId === 1) requests.record(mutation);
	});
	let currentSession = true;
	let cursor: number | null = 1;
	let fetching = false;
	const start = () => {
		const response = deferred<{ messages: TJoinedMessage[]; nextCursor: number | null }>();
		const request = requests.begin(() => currentSession, true);
		fetching = true;
		const done = loadMessagePage({
			query: () => response.promise,
			isCurrent: request.isCurrent,
			getLoadedMessages: () => useServerStore.getState().messagesMap[1] ?? [],
			getFileLinkVersion: () => 'same',
			applyLatestMessagePage: (page) => {
				useServerStore.getState().applyLatestMessagePage({ channelId: 1, messages: request.reconcile(page) });
			},
			addMessages: () => {
				throw new Error('Expected reconciliation');
			},
			refreshFileAccessTokens: async () => {},
		})
			.then((nextCursor) => {
				if (request.isCurrent()) cursor = nextCursor;
			})
			.catch(() => {})
			.finally(() => {
				if (request.isCurrent()) fetching = false;
				request.finish();
			});
		return { response, done };
	};
	return {
		start,
		requests,
		unsubscribe,
		endSession: () => {
			currentSession = false;
		},
		cursor: () => cursor,
		fetching: () => fetching,
	};
};

describe('deferred reconnect page reconciliation', () => {
	beforeEach(() => useServerStore.getState().resetState());
	it('replays append, edit, delete and reaction rows in arrival order over the full raw page', async () => {
		const h = setup();
		const load = h.start();
		const edited = message(1, 'live edit');
		const reaction = {
			...message(2),
			reactions: [{ file: null, fileId: null, messageId: 2, userId: 1, emoji: '👍', createdAt: 1 }],
		};
		recordMessageMutation(1, { message: message(4), insert: true });
		recordMessageMutation(1, { message: message(100, 'old history edit') });
		recordMessageMutation(1, { message: edited });
		recordMessageMutation(1, { deletedId: 3 });
		recordMessageMutation(1, { message: reaction });
		load.response.resolve({ messages: [message(3), message(2), message(1)], nextCursor: 99 });
		await load.done;
		expect(useServerStore.getState().messagesMap[1]).toEqual([edited, reaction, message(4)]);
		expect(h.cursor()).toBe(99);
		expect(h.fetching()).toBe(false);
		h.unsubscribe();
	});
	it('fences overlapping reloads including stale failure/finally and preserves the newest journal', async () => {
		const h = setup();
		const old = h.start();
		const latest = h.start();
		old.response.reject(new Error('obsolete'));
		await old.done;
		expect(h.fetching()).toBe(true);
		recordMessageMutation(1, { message: message(3), insert: true });
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
