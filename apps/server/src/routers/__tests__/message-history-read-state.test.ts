import { describe, expect, test } from 'bun:test';
import { ServerEvents } from '@sharkord/shared';
import { and, eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { getChannelsReadStatesForUser } from '../../db/queries/channels';
import { channelReadStates, messages } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';

const seedUnreadHistory = () => {
	const older = tdb
		.insert(messages)
		.values({ channelId: 1, userId: 1, content: 'Already read', createdAt: Date.now() + 1000 })
		.returning()
		.get();
	const newest = tdb
		.insert(messages)
		.values({ channelId: 1, userId: 1, content: 'Unread', createdAt: Date.now() + 2000 })
		.returning()
		.get();
	tdb
		.insert(channelReadStates)
		.values({ channelId: 1, userId: 2, lastReadMessageId: older.id, lastReadAt: 1000 })
		.run();
	return newest;
};

const readState = () =>
	tdb
		.select()
		.from(channelReadStates)
		.where(and(eq(channelReadStates.channelId, 1), eq(channelReadStates.userId, 2)))
		.get();

describe('message history read state', () => {
	test('history pages preserve the read state and do not publish an update', async () => {
		const { caller } = await initTest(2);
		const newest = seedUnreadHistory();
		const before = readState();
		expect((await getChannelsReadStatesForUser(2, 1))[1]).toBe(1);
		const updates: { channelId: number; count: number }[] = [];
		const subscription = pubsub
			.subscribeFor(2, ServerEvents.CHANNEL_READ_STATES_UPDATE)
			.subscribe({ next: (event) => updates.push(event) });
		try {
			const result = await caller.messages.get({ channelId: 1, cursor: newest.createdAt + 1 });
			expect(result.messages.map((message) => message.id)).toContain(newest.id);
			expect(readState()).toEqual(before);
			expect(updates).toEqual([]);
			expect((await getChannelsReadStatesForUser(2, 1))[1]).toBe(1);
		} finally {
			subscription.unsubscribe();
		}
	});

	test.each([
		undefined,
		null,
	])('opening a channel with cursor %s marks the latest message read and publishes zero unread', async (cursor) => {
		const { caller } = await initTest(2);
		const newest = seedUnreadHistory();
		expect((await getChannelsReadStatesForUser(2, 1))[1]).toBe(1);
		const updates: { channelId: number; count: number }[] = [];
		const subscription = pubsub
			.subscribeFor(2, ServerEvents.CHANNEL_READ_STATES_UPDATE)
			.subscribe({ next: (event) => updates.push(event) });
		try {
			const result = await caller.messages.get({ channelId: 1, cursor, limit: 1 });
			expect(result.messages.map((message) => message.id)).toEqual([newest.id]);
			expect(readState()).toEqual({
				channelId: 1,
				userId: 2,
				lastReadMessageId: newest.id,
				lastReadAt: expect.any(Number),
			});
			expect(readState()?.lastReadAt).toBeGreaterThan(1000);
			expect(updates).toEqual([{ channelId: 1, count: 0 }]);
		} finally {
			subscription.unsubscribe();
		}
	});
});
