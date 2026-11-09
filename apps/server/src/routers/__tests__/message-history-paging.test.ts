import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';
import { db } from '../../db';
import { messages } from '../../db/schema';

const insertMessages = (timestamps: number[]) =>
	db
		.insert(messages)
		.values(
			timestamps.map((createdAt) => ({
				channelId: 2,
				userId: 1,
				content: `Message at ${createdAt}`,
				createdAt,
			})),
		)
		.returning()
		.all();

const loadHistory = async (caller: Awaited<ReturnType<typeof initTest>>['caller']) => {
	const ids: number[] = [];
	let cursor: number | null = null;

	// Bound requests so a cursor regression fails rather than hanging the suite.
	for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
		const page = await caller.messages.get({ channelId: 2, limit: 20, cursor });
		ids.push(...page.messages.map((message) => message.id));
		cursor = page.nextCursor;

		if (cursor === null) return ids;
	}

	throw new Error('Message history paging did not terminate');
};

describe('message history paging', () => {
	test('returns every message in newest-first order across page boundaries', async () => {
		const { caller } = await initTest();
		const inserted = insertMessages(Array.from({ length: 45 }, (_, index) => 1000 + index));

		const ids = await loadHistory(caller);

		expect(ids).toEqual(inserted.toReversed().map((message) => message.id));
	});

	test('includes every id when timestamp ties straddle a page boundary', async () => {
		const { caller } = await initTest();
		const inserted = insertMessages([...Array.from({ length: 19 }, (_, index) => 1001 + index), 1000, 1000, 1000, 999]);
		const expected = inserted.toSorted((a, b) => b.createdAt - a.createdAt || b.id - a.id);

		const ids = await loadHistory(caller);

		expect([...new Set(ids)]).toEqual(expected.map((message) => message.id));
	});

	test('clamps oversized requests to 100 messages and preserves the default', async () => {
		const { caller } = await initTest();
		const inserted = insertMessages(Array.from({ length: 105 }, (_, index) => 1000 + index));
		const expectedIds = inserted
			.toReversed()
			.slice(0, 100)
			.map((message) => message.id);

		const page = await caller.messages.get({ channelId: 2, limit: 1000 });
		const defaultPage = await caller.messages.get({ channelId: 2 });

		expect(page.messages.map((message) => message.id)).toEqual(expectedIds);
		expect(page.nextCursor).not.toBeNull();
		expect(defaultPage.messages.map((message) => message.id)).toEqual(expectedIds);
	});

	for (const limit of [0, -1, 1.5]) {
		test(`rejects invalid page size ${limit}`, async () => {
			const { caller } = await initTest();

			await expect(caller.messages.get({ channelId: 2, limit })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		});
	}

	test('terminates on a timestamp group larger than a page, skipping its overflow rows', async () => {
		const { caller } = await initTest();
		const inserted = insertMessages([999, ...Array.from({ length: 25 }, () => 1000)]);
		const expectedFirstPage = inserted
			.toReversed()
			.slice(0, 20)
			.map((message) => message.id);

		const firstPage = await caller.messages.get({ channelId: 2, limit: 20 });
		expect(firstPage.messages.map((message) => message.id)).toEqual(expectedFirstPage);
		expect(firstPage.nextCursor).toBe(1001);

		const secondPage = await caller.messages.get({ channelId: 2, limit: 20, cursor: firstPage.nextCursor });
		expect(secondPage.messages.map((message) => message.id)).toEqual(expectedFirstPage);
		expect(secondPage.nextCursor).toBe(1000);

		const finalPage = await caller.messages.get({ channelId: 2, limit: 20, cursor: secondPage.nextCursor });
		expect(finalPage.messages.map((message) => message.createdAt)).toEqual([999]);
		expect(finalPage.nextCursor).toBeNull();
	});
});
