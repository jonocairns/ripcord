import { afterEach, expect, test } from 'bun:test';
import { ChannelPermission, ServerEvents } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { db } from '../../db';
import { channelReadStates, messages } from '../../db/schema';
import { type Events, pubsub } from '../../utils/pubsub';

const subscriptions: { unsubscribe(): void }[] = [];

afterEach(() => {
	for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
});

const observe = (userId: number) => {
	const order: ServerEvents[] = [];
	const updates: Events[ServerEvents.CHANNEL_READ_STATES_UPDATE][] = [];
	subscriptions.push(
		pubsub.subscribeFor(userId, ServerEvents.CHANNEL_CREATE).subscribe({
			next: () => order.push(ServerEvents.CHANNEL_CREATE),
		}),
		pubsub.subscribeFor(userId, ServerEvents.CHANNEL_READ_STATES_UPDATE).subscribe({
			next: (event) => {
				order.push(ServerEvents.CHANNEL_READ_STATES_UPDATE);
				updates.push(event);
			},
		}),
	);
	return { order, updates };
};

const setup = async () => {
	const { caller: owner } = await initTest(1);
	await initTest(2);
	await db.delete(messages).where(eq(messages.channelId, 1));
	await owner.channels.update({ channelId: 1, private: true });
	const roleId = await owner.roles.add();
	await owner.channels.updatePermissions({ channelId: 1, roleId, permissions: [ChannelPermission.VIEW_CHANNEL] });
	return { owner, roleId };
};

for (const path of ['channel override', 'role add']) {
	for (const history of [true, false]) {
		test(`${path} sends the current unread count after create (${history ? 'history' : 'empty channel'})`, async () => {
			const { owner, roleId } = await setup();
			if (history) {
				const [readMessage] = await db
					.insert(messages)
					.values({ channelId: 1, userId: 1, content: 'Already read', createdAt: 1 })
					.returning();
				if (!readMessage) throw new Error('Missing read message');
				await db
					.insert(channelReadStates)
					.values({ channelId: 1, userId: 2, lastReadMessageId: readMessage.id, lastReadAt: 1 });
				await db.insert(messages).values([
					{ channelId: 1, userId: 1, content: 'Unread', createdAt: 2 },
					{ channelId: 1, userId: 2, content: 'Own message', createdAt: 3 },
					{ channelId: 1, userId: 1, content: 'Also unread', createdAt: 4 },
				]);
				const [deletedMessage] = await db
					.insert(messages)
					.values({ channelId: 1, userId: 1, content: 'Deleted', createdAt: 5 })
					.returning();
				if (!deletedMessage) throw new Error('Missing deleted message');
				await db.delete(messages).where(eq(messages.id, deletedMessage.id));
			}
			const member = observe(2);
			const existingViewer = observe(1);
			if (path === 'channel override') {
				await owner.channels.updatePermissions({
					channelId: 1,
					userId: 2,
					permissions: [ChannelPermission.VIEW_CHANNEL],
				});
			} else {
				await owner.users.addRole({ userId: 2, roleId });
			}
			expect(member.updates).toEqual([{ channelId: 1, count: history ? 2 : 0 }]);
			expect(member.order).toEqual([ServerEvents.CHANNEL_CREATE, ServerEvents.CHANNEL_READ_STATES_UPDATE]);
			expect(existingViewer.updates).toEqual([]);
		});
	}

	for (const access of ['unchanged viewer', 'never viewer', 'losing viewer']) {
		test(`${path} sends no unread update for ${access}`, async () => {
			const { owner, roleId } = await setup();
			if (access !== 'never viewer') {
				await owner.channels.updatePermissions({
					channelId: 1,
					userId: 2,
					permissions: [ChannelPermission.VIEW_CHANNEL],
				});
			}
			const member = observe(2);
			if (path === 'channel override') {
				await owner.channels.updatePermissions({
					channelId: 1,
					userId: 2,
					permissions: access === 'unchanged viewer' ? [ChannelPermission.VIEW_CHANNEL] : [],
				});
			} else if (access === 'losing viewer') {
				await owner.users.addRole({ userId: 2, roleId });
				await owner.channels.deletePermissions({ channelId: 1, userId: 2 });
				await owner.users.removeRole({ userId: 2, roleId });
			} else {
				const unrelatedRoleId = await owner.roles.add();
				await owner.users.addRole({ userId: 2, roleId: unrelatedRoleId });
			}
			expect(member.updates).toEqual([]);
		});
	}
}

test('making a private channel public sends the current unread count after create', async () => {
	const { owner } = await setup();
	await db.insert(messages).values({ channelId: 1, userId: 1, content: 'Unread', createdAt: 1 });
	const member = observe(2);

	await owner.channels.update({ channelId: 1, private: false });

	expect(member.updates).toEqual([{ channelId: 1, count: 1 }]);
	expect(member.order).toEqual([ServerEvents.CHANNEL_CREATE, ServerEvents.CHANNEL_READ_STATES_UPDATE]);
});
