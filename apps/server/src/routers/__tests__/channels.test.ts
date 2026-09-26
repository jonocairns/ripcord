import { describe, expect, test } from 'bun:test';
import { ChannelPermission, ChannelType, ServerEvents } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { tdb } from '../../__tests__/setup';
import { getAffectedUserIdsForChannel, getChannelsReadStatesForUser } from '../../db/queries/channels';
import { channels } from '../../db/schema';
import { generateFileToken, verifyFileToken } from '../../helpers/files-crypto';
import { pubsub } from '../../utils/pubsub';

// The file access token never leaves the server, so token tests read the row.
const getChannelRow = async (channelId: number) => {
	const channel = await tdb.select().from(channels).where(eq(channels.id, channelId)).get();

	if (!channel) throw new Error(`Channel ${channelId} not found`);

	return channel;
};

describe('channels router', () => {
	test('should throw when user lacks permissions (add)', async () => {
		const { caller } = await initTest(2);

		await expect(
			caller.channels.add({
				type: ChannelType.TEXT,
				name: 'new-channel',
				categoryId: 1,
			}),
		).rejects.toThrow('Insufficient permissions');
	});

	test('should throw when user lacks permissions (get)', async () => {
		const { caller } = await initTest(2);

		await expect(
			caller.channels.get({
				channelId: 1,
			}),
		).rejects.toThrow('Insufficient permissions');
	});

	test('should throw when user lacks permissions (update)', async () => {
		const { caller } = await initTest(2);

		await expect(
			caller.channels.update({
				channelId: 1,
				name: 'updated-channel',
				topic: 'Updated topic',
				private: false,
			}),
		).rejects.toThrow('Insufficient permissions');
	});

	test('should throw when user lacks permissions (delete)', async () => {
		const { caller } = await initTest(2);

		await expect(
			caller.channels.delete({
				channelId: 1,
			}),
		).rejects.toThrow('Insufficient permissions');
	});

	test('should throw when user lacks permissions (reorder)', async () => {
		const { caller } = await initTest(2);

		await expect(
			caller.channels.reorder({
				categoryId: 1,
				channelIds: [2, 1],
			}),
		).rejects.toThrow('Insufficient permissions');
	});

	test('should throw when user lacks permissions (updatePermissions)', async () => {
		const { caller } = await initTest(2);

		await expect(
			caller.channels.updatePermissions({
				channelId: 1,
				roleId: 1,
				permissions: [ChannelPermission.VIEW_CHANNEL],
			}),
		).rejects.toThrow('Insufficient permissions');
	});

	test('should throw when user lacks permissions (getPermissions)', async () => {
		const { caller } = await initTest(2);

		await expect(
			caller.channels.getPermissions({
				channelId: 1,
			}),
		).rejects.toThrow('Insufficient permissions');
	});

	test('should throw when user lacks permissions (deletePermissions)', async () => {
		const { caller } = await initTest(2);

		await expect(
			caller.channels.deletePermissions({
				channelId: 1,
				roleId: 1,
			}),
		).rejects.toThrow('Insufficient permissions');
	});

	test('should throw when user lacks permissions (rotateFileAccessToken)', async () => {
		const { caller } = await initTest(2);

		await expect(
			caller.channels.rotateFileAccessToken({
				channelId: 1,
			}),
		).rejects.toThrow('Insufficient permissions');
	});

	test('should create a new text channel', async () => {
		const { caller } = await initTest();

		await caller.channels.add({
			type: ChannelType.TEXT,
			name: 'test-channel',
			categoryId: 1,
		});

		const channel = await caller.channels.get({
			channelId: 3,
		});

		expect(channel).toBeDefined();
		expect(channel.name).toBe('test-channel');
		expect(channel.type).toBe(ChannelType.TEXT);
		expect(channel.categoryId).toBe(1);
	});

	test('should create a new voice channel', async () => {
		const { caller } = await initTest();

		await caller.channels.add({
			type: ChannelType.VOICE,
			name: 'voice-lounge',
			categoryId: 1,
		});

		const channel = await caller.channels.get({
			channelId: 3,
		});

		expect(channel).toBeDefined();
		expect(channel.name).toBe('voice-lounge');
		expect(channel.type).toBe(ChannelType.VOICE);
	});

	test('should get existing channel', async () => {
		const { caller } = await initTest();

		const channel = await caller.channels.get({
			channelId: 1,
		});

		expect(channel).toBeDefined();
		expect(channel.id).toBe(1);
		expect(channel.name).toBeDefined();
	});

	test('should update channel name, topic, and private status', async () => {
		const { caller } = await initTest();

		await caller.channels.update({
			channelId: 1,
			name: 'updated-channel',
			topic: 'This is a test topic',
			private: true,
		});

		const channel = await caller.channels.get({
			channelId: 1,
		});

		expect(channel.name).toBe('updated-channel');
		expect(channel.topic).toBe('This is a test topic');
		expect(channel.private).toBe(true);
	});

	test('should update channel topic to null', async () => {
		const { caller } = await initTest();

		await caller.channels.update({
			channelId: 1,
			name: 'test-channel',
			topic: null,
			private: false,
		});

		const channel = await caller.channels.get({
			channelId: 1,
		});

		expect(channel.topic).toBeNull();
	});

	test('should delete existing channel', async () => {
		const { caller } = await initTest();

		await caller.channels.add({
			type: ChannelType.TEXT,
			name: 'temp-channel',
			categoryId: 1,
		});

		await caller.channels.delete({
			channelId: 3,
		});

		await expect(
			caller.channels.get({
				channelId: 3,
			}),
		).rejects.toThrow('Channel not found');
	});

	test('should throw when deleting non-existing channel', async () => {
		const { caller } = await initTest();

		await expect(
			caller.channels.delete({
				channelId: 999,
			}),
		).rejects.toThrow('Channel not found');
	});

	test('should throw when getting non-existing channel', async () => {
		const { caller } = await initTest();

		await expect(
			caller.channels.get({
				channelId: 999,
			}),
		).rejects.toThrow('Channel not found');
	});

	test('should reorder channels in a category', async () => {
		const { caller } = await initTest();

		await caller.channels.add({
			type: ChannelType.TEXT,
			name: 'channel-a',
			categoryId: 1,
		});

		await caller.channels.add({
			type: ChannelType.TEXT,
			name: 'channel-b',
			categoryId: 1,
		});

		await caller.channels.reorder({
			categoryId: 1,
			channelIds: [4, 3, 1, 2],
		});

		const [channel1, channel2, channel3, channel4] = await Promise.all([
			caller.channels.get({ channelId: 1 }),
			caller.channels.get({ channelId: 2 }),
			caller.channels.get({ channelId: 3 }),
			caller.channels.get({ channelId: 4 }),
		]);

		expect(channel4.position).toBe(1);
		expect(channel3.position).toBe(2);
		expect(channel1.position).toBe(3);
		expect(channel2.position).toBe(4);
	});

	test('should set channel permissions for a role', async () => {
		const { caller } = await initTest();

		await caller.channels.updatePermissions({
			channelId: 1,
			roleId: 1,
			permissions: [ChannelPermission.VIEW_CHANNEL, ChannelPermission.SEND_MESSAGES],
		});

		const permissions = await caller.channels.getPermissions({
			channelId: 1,
		});

		expect(permissions).toBeDefined();
		expect(permissions.rolePermissions).toBeDefined();
		expect(permissions.rolePermissions.length).toBeGreaterThan(0);

		const rolePerms = permissions.rolePermissions.filter((p) => p.roleId === 1);

		expect(rolePerms.length).toBeGreaterThan(0);

		const viewChannelPerm = rolePerms.find((p) => p.permission === ChannelPermission.VIEW_CHANNEL);
		const sendMessagesPerm = rolePerms.find((p) => p.permission === ChannelPermission.SEND_MESSAGES);

		expect(viewChannelPerm?.allow).toBe(true);
		expect(sendMessagesPerm?.allow).toBe(true);
	});

	test('should set channel permissions for a user', async () => {
		const { caller } = await initTest();

		await caller.channels.updatePermissions({
			channelId: 1,
			userId: 1,
			permissions: [ChannelPermission.VIEW_CHANNEL],
		});

		const permissions = await caller.channels.getPermissions({
			channelId: 1,
		});

		expect(permissions.userPermissions).toBeDefined();
		expect(permissions.userPermissions.length).toBeGreaterThan(0);

		const userPerms = permissions.userPermissions.filter((p) => p.userId === 1);

		expect(userPerms.length).toBeGreaterThan(0);

		const viewChannelPerm = userPerms.find((p) => p.permission === ChannelPermission.VIEW_CHANNEL);

		expect(viewChannelPerm?.allow).toBe(true);
	});

	test('should create empty permission set with isCreate flag', async () => {
		const { caller } = await initTest();

		await caller.channels.updatePermissions({
			channelId: 1,
			roleId: 2,
			isCreate: true,
			permissions: [ChannelPermission.VIEW_CHANNEL], // should be ignored
		});

		const permissions = await caller.channels.getPermissions({
			channelId: 1,
		});

		const rolePerms = permissions.rolePermissions.filter((p) => p.roleId === 2);
		const allowedPerms = rolePerms.filter((p) => p.allow);

		expect(allowedPerms.length).toBe(0);
	});

	test('should delete channel permissions for a role', async () => {
		const { caller } = await initTest();

		await caller.channels.updatePermissions({
			channelId: 1,
			roleId: 1,
			permissions: [ChannelPermission.VIEW_CHANNEL],
		});

		let permissions = await caller.channels.getPermissions({
			channelId: 1,
		});

		const rolePermsBeforeDelete = permissions.rolePermissions.filter((p) => p.roleId === 1);

		expect(rolePermsBeforeDelete.length).toBeGreaterThan(0);

		await caller.channels.deletePermissions({
			channelId: 1,
			roleId: 1,
		});

		permissions = await caller.channels.getPermissions({
			channelId: 1,
		});

		const rolePermsAfterDelete = permissions.rolePermissions.filter((p) => p.roleId === 1);

		expect(rolePermsAfterDelete.length).toBe(0);
	});

	test('should delete channel permissions for a user', async () => {
		const { caller } = await initTest();

		await caller.channels.updatePermissions({
			channelId: 1,
			userId: 1,
			permissions: [ChannelPermission.VIEW_CHANNEL],
		});

		let permissions = await caller.channels.getPermissions({
			channelId: 1,
		});

		const userPermsBeforeDelete = permissions.userPermissions.filter((p) => p.userId === 1);

		expect(userPermsBeforeDelete.length).toBeGreaterThan(0);

		await caller.channels.deletePermissions({
			channelId: 1,
			userId: 1,
		});

		permissions = await caller.channels.getPermissions({
			channelId: 1,
		});

		const userPermsAfterDelete = permissions.userPermissions.filter((p) => p.userId === 1);

		expect(userPermsAfterDelete.length).toBe(0);
	});

	test('should mark channel as read', async () => {
		const { caller: caller1 } = await initTest(1);
		const { caller: caller2 } = await initTest(2);

		const beforeMsgSendReadStates = await getChannelsReadStatesForUser(2, 2);

		// before sending any messages, there should be no read state
		expect(beforeMsgSendReadStates[2]).toBeUndefined();

		await caller1.messages.send({
			channelId: 2,
			content: 'Test message for read state',
			files: [],
		});

		const beforeReadStates = await getChannelsReadStatesForUser(2, 2);

		// message has been sent, there should be 1 unread message
		expect(beforeReadStates[2]).toBeDefined();
		expect(beforeReadStates[2]).toBe(1);

		await caller2.channels.markAsRead({
			channelId: 2,
		});

		const afterReadStates = await getChannelsReadStatesForUser(2, 2);

		// after marking as read, there should be 0 unread messages
		expect(afterReadStates[2]).toBeDefined();
		expect(afterReadStates[2]).toBe(0);
	});

	test('should mark channel as read with no messages', async () => {
		const { caller } = await initTest();

		// channel 2 has no messages, so marking as read should do nothing
		await caller.channels.markAsRead({
			channelId: 2,
		});

		const readStates = await getChannelsReadStatesForUser(1, 2);

		// should not create a read state for empty channel
		expect(readStates[2]).toBeUndefined();
	});

	test('should update existing read state when marking as read again', async () => {
		const { caller: caller1 } = await initTest(1);
		const { caller: caller2 } = await initTest(2);

		// user 1 sends first message
		await caller1.messages.send({
			channelId: 2,
			content: 'First message',
			files: [],
		});

		// user 2 marks as read
		await caller2.channels.markAsRead({
			channelId: 2,
		});

		const firstReadStates = await getChannelsReadStatesForUser(2, 2);

		expect(firstReadStates[2]).toBe(0);

		// user 1 sends another message
		await caller1.messages.send({
			channelId: 2,
			content: 'Second message',
			files: [],
		});

		const beforeSecondMark = await getChannelsReadStatesForUser(2, 2);

		expect(beforeSecondMark[2]).toBe(1);

		// user 2 marks as read again
		await caller2.channels.markAsRead({
			channelId: 2,
		});

		const afterSecondMark = await getChannelsReadStatesForUser(2, 2);

		expect(afterSecondMark[2]).toBe(0);
	});

	test('should track unread count correctly with multiple messages', async () => {
		const { caller: caller1 } = await initTest(1);
		const { caller: caller2 } = await initTest(2);

		// user 1 sends 3 messages
		await caller1.messages.send({
			channelId: 2,
			content: 'Message 1',
			files: [],
		});

		await caller1.messages.send({
			channelId: 2,
			content: 'Message 2',
			files: [],
		});

		await caller1.messages.send({
			channelId: 2,
			content: 'Message 3',
			files: [],
		});

		const readStates = await getChannelsReadStatesForUser(2, 2);

		// user 2 should have 3 unread messages
		expect(readStates[2]).toBe(3);

		// user 2 marks as read
		await caller2.channels.markAsRead({
			channelId: 2,
		});

		const afterMark = await getChannelsReadStatesForUser(2, 2);

		expect(afterMark[2]).toBe(0);
	});

	test('should not count own messages as unread', async () => {
		const { caller } = await initTest();

		// user sends messages to channel
		await caller.messages.send({
			channelId: 2,
			content: 'My message 1',
			files: [],
		});

		await caller.messages.send({
			channelId: 2,
			content: 'My message 2',
			files: [],
		});

		const readStates = await getChannelsReadStatesForUser(1, 2);

		// should have 0 unread messages since user sent them themselves
		expect(readStates[2]).toBe(0);
	});

	test('should validate channel name length (too short)', async () => {
		const { caller } = await initTest();

		await expect(
			caller.channels.add({
				type: ChannelType.TEXT,
				name: '',
				categoryId: 1,
			}),
		).rejects.toThrow();
	});

	test('should validate channel name length (too long)', async () => {
		const { caller } = await initTest();

		await expect(
			caller.channels.add({
				type: ChannelType.TEXT,
				name: 'this-is-a-very-long-channel-name-that-exceeds-the-limit',
				categoryId: 1,
			}),
		).rejects.toThrow();
	});

	test('should validate topic length (too long)', async () => {
		const { caller } = await initTest();

		await expect(
			caller.channels.update({
				channelId: 1,
				name: 'test-channel',
				topic: 'a'.repeat(200),
				private: false,
			}),
		).rejects.toThrow();
	});

	test('should create channel with incrementing position', async () => {
		const { caller } = await initTest();

		await caller.channels.add({
			type: ChannelType.TEXT,
			name: 'first-channel',
			categoryId: 1,
		});

		const firstChannel = await caller.channels.get({ channelId: 3 });

		await caller.channels.add({
			type: ChannelType.TEXT,
			name: 'second-channel',
			categoryId: 1,
		});

		const secondChannel = await caller.channels.get({ channelId: 4 });

		expect(secondChannel.position).toBeGreaterThan(firstChannel.position);
	});

	test('should allow multiple permission types on same channel', async () => {
		const { caller } = await initTest();

		await caller.channels.updatePermissions({
			channelId: 1,
			roleId: 1,
			permissions: [ChannelPermission.VIEW_CHANNEL],
		});

		await caller.channels.updatePermissions({
			channelId: 1,
			userId: 1,
			permissions: [ChannelPermission.SEND_MESSAGES],
		});

		const permissions = await caller.channels.getPermissions({
			channelId: 1,
		});

		expect(permissions.rolePermissions.length).toBeGreaterThan(0);
		expect(permissions.userPermissions.length).toBeGreaterThan(0);
	});

	test('should update existing permissions when called again', async () => {
		const { caller } = await initTest();

		await caller.channels.updatePermissions({
			channelId: 1,
			roleId: 1,
			permissions: [ChannelPermission.VIEW_CHANNEL],
		});

		await caller.channels.updatePermissions({
			channelId: 1,
			roleId: 1,
			permissions: [ChannelPermission.VIEW_CHANNEL, ChannelPermission.SEND_MESSAGES],
		});

		const permissions = await caller.channels.getPermissions({
			channelId: 1,
		});

		const rolePerms = permissions.rolePermissions.filter((p) => p.roleId === 1);

		const sendMessagesPerm = rolePerms.find((p) => p.permission === ChannelPermission.SEND_MESSAGES);

		expect(sendMessagesPerm?.allow).toBe(true);
	});

	test('should create channels in different categories', async () => {
		const { caller } = await initTest();

		await caller.channels.add({
			type: ChannelType.TEXT,
			name: 'cat-1-channel',
			categoryId: 1,
		});

		await caller.channels.add({
			type: ChannelType.TEXT,
			name: 'cat-2-channel',
			categoryId: 2,
		});

		const channel1 = await caller.channels.get({ channelId: 3 });
		const channel2 = await caller.channels.get({ channelId: 4 });

		expect(channel1.categoryId).toBe(1);
		expect(channel2.categoryId).toBe(2);
	});

	test('should rotate file access token for a channel', async () => {
		const { caller } = await initTest();

		const channelBefore = await getChannelRow(1);
		const originalToken = channelBefore.fileAccessToken;

		expect(originalToken).toBeDefined();
		expect(channelBefore.fileAccessTokenUpdatedAt).toBeDefined();

		await caller.channels.rotateFileAccessToken({
			channelId: 1,
		});

		const channelAfter = await getChannelRow(1);
		const newToken = channelAfter.fileAccessToken;

		expect(newToken).toBeDefined();
		expect(newToken).not.toBe(originalToken);
		expect(channelAfter.fileAccessTokenUpdatedAt).toBeGreaterThan(channelBefore.fileAccessTokenUpdatedAt!);
	});

	test('should throw when rotating token for non-existing channel', async () => {
		const { caller } = await initTest();

		await expect(
			caller.channels.rotateFileAccessToken({
				channelId: 999,
			}),
		).rejects.toThrow('Channel not found');
	});

	test('should generate unique tokens on multiple rotations', async () => {
		const { caller } = await initTest();

		const channel = await getChannelRow(1);
		const originalToken = channel.fileAccessToken;

		await caller.channels.rotateFileAccessToken({
			channelId: 1,
		});

		const afterFirstRotation = await getChannelRow(1);
		const firstNewToken = afterFirstRotation.fileAccessToken;

		await caller.channels.rotateFileAccessToken({
			channelId: 1,
		});

		const afterSecondRotation = await getChannelRow(1);
		const secondNewToken = afterSecondRotation.fileAccessToken;

		expect(originalToken).not.toBe(firstNewToken);
		expect(firstNewToken).not.toBe(secondNewToken);
		expect(originalToken).not.toBe(secondNewToken);
	});

	test('should invalidate old file tokens after rotation', async () => {
		const { caller } = await initTest();

		await caller.channels.update({
			channelId: 1,
			private: true,
		});

		const channelBefore = await getChannelRow(1);
		const oldToken = channelBefore.fileAccessToken;

		const oldFileToken = generateFileToken(123, oldToken);

		await caller.channels.rotateFileAccessToken({
			channelId: 1,
		});

		const channelAfter = await getChannelRow(1);
		const newToken = channelAfter.fileAccessToken;

		const newFileToken = generateFileToken(123, newToken);

		expect(oldFileToken).not.toBe(newFileToken);

		const isOldTokenValid = verifyFileToken(123, newToken, oldFileToken);
		const isNewTokenValid = verifyFileToken(123, newToken, newFileToken);

		expect(isOldTokenValid).toBe(false);
		expect(isNewTokenValid).toBe(true);
	});

	test('should allow rotating token for both public and private channels', async () => {
		const { caller } = await initTest();

		const publicChannelBefore = await getChannelRow(1);
		const publicTokenBefore = publicChannelBefore.fileAccessToken;

		await caller.channels.rotateFileAccessToken({
			channelId: 1,
		});

		const publicChannelAfter = await getChannelRow(1);
		const publicTokenAfter = publicChannelAfter.fileAccessToken;

		expect(publicTokenAfter).not.toBe(publicTokenBefore);

		await caller.channels.update({
			channelId: 2,
			private: true,
		});

		const privateChannelBefore = await getChannelRow(2);
		const privateTokenBefore = privateChannelBefore.fileAccessToken;

		await caller.channels.rotateFileAccessToken({
			channelId: 2,
		});

		const privateChannelAfter = await getChannelRow(2);
		const privateTokenAfter = privateChannelAfter.fileAccessToken;

		expect(privateTokenAfter).not.toBe(privateTokenBefore);
	});
});

type TChannelEvent =
	| { type: 'create' | 'update'; channel: Record<string, unknown> }
	| { type: 'delete'; channelId: number }
	| { type: 'permissions'; canView: Record<number, boolean> };

// Records the channel events delivered to one user, in delivery order.
const recordChannelEvents = (userId: number) => {
	const events: TChannelEvent[] = [];
	const subscriptions = [
		pubsub.subscribeFor(userId, ServerEvents.CHANNEL_CREATE).subscribe({
			next: (channel) => events.push({ type: 'create', channel }),
		}),
		pubsub.subscribeFor(userId, ServerEvents.CHANNEL_UPDATE).subscribe({
			next: (channel) => events.push({ type: 'update', channel }),
		}),
		pubsub.subscribeFor(userId, ServerEvents.CHANNEL_DELETE).subscribe({
			next: (channelId) => events.push({ type: 'delete', channelId }),
		}),
		pubsub.subscribeFor(userId, ServerEvents.CHANNEL_PERMISSIONS_UPDATE).subscribe({
			next: (permissions) =>
				events.push({
					type: 'permissions',
					canView: Object.fromEntries(
						Object.values(permissions).map((entry) => [entry.channelId, entry.permissions.VIEW_CHANNEL]),
					),
				}),
		}),
	];

	return {
		events,
		clear: () => {
			events.length = 0;
		},
		stop: () => {
			for (const subscription of subscriptions) subscription.unsubscribe();
		},
	};
};

// Some routes publish without awaiting; wait until an expected event arrives.
const waitForEvent = async (events: TChannelEvent[], predicate: (event: TChannelEvent) => boolean) => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (events.some(predicate)) return;
		await Bun.sleep(5);
	}

	throw new Error('Timed out waiting for channel event');
};

const isChannelPayload = (channelId: number, type: 'create' | 'update') => (event: TChannelEvent) =>
	event.type === type && event.channel.id === channelId;

const isChannelDelete = (channelId: number) => (event: TChannelEvent) =>
	event.type === 'delete' && event.channelId === channelId;

describe('channel event visibility', () => {
	test('private channel updates only reach users with VIEW_CHANNEL', async () => {
		const { caller } = await initTest(1);
		const ownerEvents = recordChannelEvents(1);
		const memberEvents = recordChannelEvents(2);

		try {
			await caller.channels.update({ channelId: 1, private: true });

			expect(memberEvents.events.some(isChannelDelete(1))).toBe(true);

			ownerEvents.clear();
			memberEvents.clear();

			await caller.channels.update({ channelId: 1, topic: 'secret plans' });
			await waitForEvent(ownerEvents.events, isChannelPayload(1, 'update'));

			expect(memberEvents.events).toEqual([]);
		} finally {
			ownerEvents.stop();
			memberEvents.stop();
		}
	});

	test('a channel created then made private is withdrawn from users without access', async () => {
		const { caller } = await initTest(1);
		const memberEvents = recordChannelEvents(2);

		try {
			const channelId = await caller.channels.add({ type: ChannelType.TEXT, name: 'staff', categoryId: 1 });

			await waitForEvent(memberEvents.events, isChannelPayload(channelId, 'create'));
			await caller.channels.update({ channelId, private: true, topic: 'staff only' });

			expect(memberEvents.events.at(-1)).toEqual({ type: 'delete', channelId });
			expect(
				memberEvents.events.some(
					(event) => event.type !== 'delete' && event.type !== 'permissions' && event.channel.topic,
				),
			).toBe(false);
		} finally {
			memberEvents.stop();
		}
	});

	test('public-to-private withdrawal lets shipped clients deselect without revealing new details', async () => {
		const { caller } = await initTest(1);
		const previousChannel = await getChannelRow(1);
		const memberEvents = recordChannelEvents(2);
		try {
			await caller.channels.update({ channelId: 1, private: true, name: 'secret-name', topic: 'secret-topic' });
			expect(memberEvents.events).toEqual([
				{
					type: 'update',
					channel: expect.objectContaining({
						id: 1,
						private: true,
						name: previousChannel.name,
						topic: previousChannel.topic,
					}),
				},
				{ type: 'permissions', canView: expect.objectContaining({ 1: false }) },
				{ type: 'delete', channelId: 1 },
			]);
			for (const event of memberEvents.events) {
				if (event.type === 'update') expect(event.channel).not.toHaveProperty('fileAccessToken');
			}
		} finally {
			memberEvents.stop();
		}
	});

	test('granting and revoking a user permission adds and removes the channel', async () => {
		const { caller } = await initTest(1);

		await caller.channels.update({ channelId: 1, private: true, topic: 'secret plans' });

		const memberEvents = recordChannelEvents(2);

		try {
			await caller.channels.updatePermissions({
				channelId: 1,
				userId: 2,
				permissions: [ChannelPermission.VIEW_CHANNEL],
			});

			expect(memberEvents.events.map((event) => event.type)).toEqual(['permissions', 'create']);
			expect(memberEvents.events[1]).toMatchObject({
				type: 'create',
				channel: { id: 1, private: true, topic: 'secret plans' },
			});

			memberEvents.clear();

			await caller.channels.update({ channelId: 1, topic: 'new plans' });
			await waitForEvent(memberEvents.events, isChannelPayload(1, 'update'));

			memberEvents.clear();

			await caller.channels.updatePermissions({ channelId: 1, userId: 2, permissions: [] });

			// Permissions first, so a client viewing the channel can still see it is
			// private when it learns it lost access.
			expect(memberEvents.events).toEqual([
				{ type: 'permissions', canView: expect.objectContaining({ 1: false }) },
				{ type: 'delete', channelId: 1 },
			]);
		} finally {
			memberEvents.stop();
		}
	});

	test('deleting a user permission override re-evaluates access', async () => {
		const { caller } = await initTest(1);

		await caller.channels.update({ channelId: 1, private: true });
		await caller.channels.updatePermissions({ channelId: 1, userId: 2, permissions: [ChannelPermission.VIEW_CHANNEL] });

		const memberEvents = recordChannelEvents(2);

		try {
			await caller.channels.deletePermissions({ channelId: 1, userId: 2 });

			expect(memberEvents.events.at(-1)).toEqual({ type: 'delete', channelId: 1 });
		} finally {
			memberEvents.stop();
		}
	});

	test('gaining and losing a role with channel access adds and removes the channel', async () => {
		const { caller } = await initTest(1);
		const guestRoleId = 3;

		await caller.channels.update({ channelId: 1, private: true });
		await caller.channels.updatePermissions({
			channelId: 1,
			roleId: guestRoleId,
			permissions: [ChannelPermission.VIEW_CHANNEL],
		});

		const memberEvents = recordChannelEvents(2);

		try {
			await caller.users.addRole({ userId: 2, roleId: guestRoleId });

			expect(memberEvents.events.map((event) => event.type)).toEqual(['permissions', 'create']);
			expect(memberEvents.events[0]).toEqual({ type: 'permissions', canView: expect.objectContaining({ 1: true }) });

			memberEvents.clear();

			await caller.users.removeRole({ userId: 2, roleId: guestRoleId });

			expect(memberEvents.events).toEqual([
				{ type: 'permissions', canView: expect.objectContaining({ 1: false }) },
				{ type: 'delete', channelId: 1 },
			]);
		} finally {
			memberEvents.stop();
		}
	});

	test('unrelated role changes preserve an owners effective private channel permissions', async () => {
		const { caller } = await initTest(1);
		await caller.channels.update({ channelId: 1, private: true });
		// Owner access also overrides an explicit user deny.
		await caller.channels.updatePermissions({ channelId: 1, userId: 1, permissions: [] });
		const ownerEvents = recordChannelEvents(1);
		try {
			await caller.users.addRole({ userId: 1, roleId: 3 });
			expect(ownerEvents.events[0]).toEqual({ type: 'permissions', canView: expect.objectContaining({ 1: true }) });
			expect(ownerEvents.events.some(isChannelDelete(1))).toBe(false);
			ownerEvents.clear();
			await caller.users.removeRole({ userId: 1, roleId: 3 });
			expect(ownerEvents.events[0]).toEqual({ type: 'permissions', canView: expect.objectContaining({ 1: true }) });
			expect(ownerEvents.events.some(isChannelDelete(1))).toBe(false);
		} finally {
			ownerEvents.stop();
		}
	});

	test('a user-level deny overrides a role that grants VIEW_CHANNEL', async () => {
		const { caller } = await initTest(1);
		const memberRoleId = 2;

		await caller.channels.update({ channelId: 1, private: true });
		await caller.channels.updatePermissions({
			channelId: 1,
			roleId: memberRoleId,
			permissions: [ChannelPermission.VIEW_CHANNEL],
		});
		await caller.channels.updatePermissions({ channelId: 1, userId: 2, permissions: [] });

		expect(await getAffectedUserIdsForChannel(1, { permission: ChannelPermission.VIEW_CHANNEL })).not.toContain(2);

		const memberEvents = recordChannelEvents(2);
		const ownerEvents = recordChannelEvents(1);

		try {
			await caller.channels.update({ channelId: 1, topic: 'not for you' });
			await waitForEvent(ownerEvents.events, isChannelPayload(1, 'update'));

			expect(memberEvents.events).toEqual([]);
		} finally {
			memberEvents.stop();
			ownerEvents.stop();
		}
	});

	test('making a private channel public delivers it to everyone', async () => {
		const { caller } = await initTest(1);

		await caller.channels.update({ channelId: 1, private: true });

		const memberEvents = recordChannelEvents(2);

		try {
			await caller.channels.update({ channelId: 1, private: false });

			expect(memberEvents.events.some(isChannelPayload(1, 'create'))).toBe(true);
		} finally {
			memberEvents.stop();
		}
	});

	test('no channel payload sent to clients contains the file access token', async () => {
		const { caller, initialData } = await initTest(1);
		const ownerEvents = recordChannelEvents(1);

		try {
			await caller.channels.update({ channelId: 1, topic: 'token check' });
			await waitForEvent(ownerEvents.events, isChannelPayload(1, 'update'));

			const channelId = await caller.channels.add({ type: ChannelType.TEXT, name: 'token-check', categoryId: 1 });
			await waitForEvent(ownerEvents.events, isChannelPayload(channelId, 'create'));

			await caller.channels.update({ channelId, private: true });
			await caller.channels.updatePermissions({ channelId, userId: 2, permissions: [ChannelPermission.VIEW_CHANNEL] });

			const payloads = [
				...initialData.channels,
				await caller.channels.get({ channelId: 1 }),
				...ownerEvents.events.flatMap((event) =>
					event.type === 'create' || event.type === 'update' ? [event.channel] : [],
				),
			];

			expect(initialData.channels.length).toBeGreaterThan(0);

			for (const payload of payloads) {
				expect(payload).not.toHaveProperty('fileAccessToken');
				expect(payload).toHaveProperty('fileAccessTokenUpdatedAt');
			}
		} finally {
			ownerEvents.stop();
		}
	});
});
