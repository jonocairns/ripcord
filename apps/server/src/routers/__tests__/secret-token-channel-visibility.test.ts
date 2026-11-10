import { afterEach, expect, test } from 'bun:test';
import { ChannelPermission, ServerEvents } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { TEST_SECRET_TOKEN } from '../../__tests__/seed';
import { db } from '../../db';
import { channelReadStates, messages } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { type Events, pubsub } from '../../utils/pubsub';

const subscriptions: { unsubscribe(): void }[] = [];
const state = { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false };

const observe = (userId: number) => {
	const order: ServerEvents[] = [];
	const watch = <T extends keyof Events>(topic: T) => {
		const events: Events[T][] = [];
		subscriptions.push(
			pubsub.subscribeFor(userId, topic).subscribe({
				next: (event) => {
					order.push(topic);
					events.push(event);
				},
			}),
		);
		return events;
	};
	return {
		order,
		creates: watch(ServerEvents.CHANNEL_CREATE),
		permissions: watch(ServerEvents.CHANNEL_PERMISSIONS_UPDATE),
		unread: watch(ServerEvents.CHANNEL_READ_STATES_UPDATE),
		joins: watch(ServerEvents.USER_JOIN_VOICE),
	};
};

const setup = async () => {
	const { caller: owner } = await initTest(1);
	const { caller: member } = await initTest(2);
	await owner.channels.update({ channelId: 1, private: true });
	db.delete(messages).where(eq(messages.channelId, 1)).run();
	return { owner, member };
};

afterEach(async () => {
	for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
	const runtime = VoiceRuntime.findById(2);
	if (runtime) {
		for (const user of [...runtime.getState().users]) runtime.removeUser(user.userId);
		await runtime.destroy();
	}
});

test('secret token immediately creates a previously hidden private channel for the new owner', async () => {
	const { member } = await setup();
	const viewer = observe(2);
	await member.others.useSecretToken({ token: TEST_SECRET_TOKEN });
	expect(viewer.creates).toEqual([expect.objectContaining({ id: 1, private: true })]);
});

test('secret token publishes owner channel permissions before creating the private channel', async () => {
	const { member } = await setup();
	const viewer = observe(2);
	await member.others.useSecretToken({ token: TEST_SECRET_TOKEN });
	expect(viewer.permissions).toEqual([
		expect.objectContaining({
			1: expect.objectContaining({ permissions: expect.objectContaining({ [ChannelPermission.VIEW_CHANNEL]: true }) }),
		}),
	]);
	expect(viewer.order.indexOf(ServerEvents.CHANNEL_PERMISSIONS_UPDATE)).toBeLessThan(
		viewer.order.indexOf(ServerEvents.CHANNEL_CREATE),
	);
});

for (const history of [true, false]) {
	test(`secret token sends unread count after create (${history ? 'history' : 'empty'})`, async () => {
		const { member } = await setup();
		if (history) {
			const readMessage = db
				.insert(messages)
				.values({ channelId: 1, userId: 1, content: 'Read', createdAt: 1 })
				.returning()
				.get();
			if (!readMessage) throw new Error('Missing read message');
			db.insert(channelReadStates)
				.values({ channelId: 1, userId: 2, lastReadMessageId: readMessage.id, lastReadAt: 1 })
				.run();
			db.insert(messages)
				.values([
					{ channelId: 1, userId: 1, content: 'Unread', createdAt: 2 },
					{ channelId: 1, userId: 2, content: 'Own message', createdAt: 3 },
					{ channelId: 1, userId: 1, content: 'Also unread', createdAt: 4 },
				])
				.run();
		}
		const viewer = observe(2);
		await member.others.useSecretToken({ token: TEST_SECRET_TOKEN });
		expect(viewer.unread).toEqual([{ channelId: 1, count: history ? 2 : 0 }]);
		expect(viewer.order).toEqual([
			ServerEvents.CHANNEL_PERMISSIONS_UPDATE,
			ServerEvents.CHANNEL_CREATE,
			ServerEvents.CHANNEL_READ_STATES_UPDATE,
		]);
	});
}

test('secret token snapshots the private voice members for the new owner', async () => {
	const { owner, member } = await setup();
	const runtime = new VoiceRuntime(2);
	await runtime.init();
	await owner.channels.update({ channelId: 2, private: true });
	await owner.voice.join({ channelId: 2, state });
	const viewer = observe(2);
	await member.others.useSecretToken({ token: TEST_SECRET_TOKEN });
	expect(viewer.joins).toEqual([{ channelId: 2, userId: 1, state, reconnecting: true }]);
});

test('secret token sends no public channel creates or visibility updates to other owners', async () => {
	const { member } = await setup();
	const viewer = observe(2);
	const existingOwner = observe(1);
	await member.others.useSecretToken({ token: TEST_SECRET_TOKEN });
	expect(viewer.creates.filter((channel) => channel.id === 2)).toEqual([]);
	expect(existingOwner.order).toEqual([]);
});

test('wrong and rate-limited secret tokens publish no permission or visibility events', async () => {
	const { member } = await setup();
	const viewer = observe(2);
	const { useSecretToken: submitSecretToken } = member.others;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		await expect(submitSecretToken({ token: 'wrong' })).rejects.toThrow('Invalid secret token');
		expect(viewer.order).toEqual([]);
	}
	await expect(member.others.useSecretToken({ token: TEST_SECRET_TOKEN })).rejects.toThrow('Too many requests');
	expect(viewer.order).toEqual([]);
});

test('duplicate owner insertion publishes no permission or visibility events', async () => {
	const { owner } = await setup();
	const viewer = observe(1);
	const member = observe(2);
	await expect(owner.others.useSecretToken({ token: TEST_SECRET_TOKEN })).rejects.toThrow();
	expect(viewer.order).toEqual([]);
	expect(member.order).toEqual([]);
});
