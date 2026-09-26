import { ChannelPermission, Permission, ServerEvents, type TChannelUserPermissionsMap } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { toPublicChannel } from '../helpers/to-public-channel';
import { pluginManager } from '../plugins';
import { pubsub } from '../utils/pubsub';
import { db } from '.';
import { getAffectedUserIdsForChannel, getAllChannelUserPermissions, getChannelsForUser } from './queries/channels';
import { getEmojiById } from './queries/emojis';
import { getMessage } from './queries/messages';
import { getRole } from './queries/roles';
import { getPublicSettings } from './queries/server';
import { getPublicUserById, getUserIdsWithPermission } from './queries/users';
import { categories, channels, users } from './schema';

const publishMessage = async (
	messageId: number | undefined,
	channelId: number | undefined,
	type: 'create' | 'update' | 'delete',
) => {
	if (!messageId || !channelId) return;

	if (type === 'delete') {
		const affectedUserIds = await getAffectedUserIdsForChannel(channelId, {
			permission: ChannelPermission.VIEW_CHANNEL,
		});

		pubsub.publishFor(affectedUserIds, ServerEvents.MESSAGE_DELETE, {
			messageId: messageId,
			channelId: channelId,
		});

		return;
	}

	const message = await getMessage(messageId);

	if (!message) return;

	const targetEvent = type === 'create' ? ServerEvents.NEW_MESSAGE : ServerEvents.MESSAGE_UPDATE;

	const affectedUserIds = await getAffectedUserIdsForChannel(channelId, {
		permission: ChannelPermission.VIEW_CHANNEL,
	});

	pubsub.publishFor(affectedUserIds, targetEvent, message);

	// only send unread updates to users OTHER than the message author
	const usersToNotify = affectedUserIds.filter((id) => id !== message.userId);

	if (usersToNotify.length > 0) {
		pubsub.publishFor(usersToNotify, ServerEvents.CHANNEL_READ_STATES_DELTA, {
			channelId,
			// this was sending the whole unread count before which was causing performance issues, now it just sends a delta of 1 which the client can use to update the unread count
			// this isn't perfectly accurate in some cases but it should be good enough for most cases and it significantly reduces the amount of work the db has to
			delta: 1,
		});
	}
};

const publishEmoji = async (emojiId: number | undefined, type: 'create' | 'update' | 'delete') => {
	if (!emojiId) return;

	if (type === 'delete') {
		pubsub.publish(ServerEvents.EMOJI_DELETE, emojiId);
		return;
	}

	const emoji = await getEmojiById(emojiId);

	if (!emoji) return;

	const targetEvent = type === 'create' ? ServerEvents.EMOJI_CREATE : ServerEvents.EMOJI_UPDATE;

	pubsub.publish(targetEvent, emoji);
};

const publishRole = async (roleId: number | undefined, type: 'create' | 'update' | 'delete') => {
	if (!roleId) return;

	if (type === 'delete') {
		pubsub.publish(ServerEvents.ROLE_DELETE, roleId);
		return;
	}

	const role = await getRole(roleId);

	if (!role) return;

	const targetEvent = type === 'create' ? ServerEvents.ROLE_CREATE : ServerEvents.ROLE_UPDATE;

	pubsub.publish(targetEvent, role);
};

const publishUser = async (userId: number | undefined, type: 'create' | 'update' | 'delete') => {
	if (!userId) return;

	if (type === 'delete') {
		const affectedUserIds = await getUserIdsWithPermission(Permission.MANAGE_USERS);

		pubsub.publishFor(affectedUserIds, ServerEvents.USER_DELETE, userId);
		return;
	}

	const user = await getPublicUserById(userId);

	if (!user) return;

	const targetEvent = type === 'create' ? ServerEvents.USER_CREATE : ServerEvents.USER_UPDATE;

	pubsub.publish(targetEvent, user);
};

const getChannelViewerIds = (channelId: number) =>
	getAffectedUserIdsForChannel(channelId, { permission: ChannelPermission.VIEW_CHANNEL });

// Channel events only reach users who may see the channel, so a private
// channel's name and topic stay hidden from everyone else.
const publishChannel = async (channelId: number | undefined, type: 'create' | 'update' | 'delete') => {
	if (!channelId) return;

	if (type === 'delete') {
		// The row is already gone, so viewers can no longer be resolved. The
		// payload is only the id, so every user may receive it.
		const allUsers = await db.select({ id: users.id }).from(users);

		pubsub.publishFor(
			allUsers.map((user) => user.id),
			ServerEvents.CHANNEL_DELETE,
			channelId,
		);
		return;
	}

	const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();

	if (!channel) return;

	const targetEvent = type === 'create' ? ServerEvents.CHANNEL_CREATE : ServerEvents.CHANNEL_UPDATE;

	pubsub.publishFor(await getChannelViewerIds(channelId), targetEvent, toPublicChannel(channel));
};

// After a change to who may view `channelId` (channel permission edits, the
// channel turning private or public), sends each of `userIds` a create if they
// can see it now and a delete if they cannot. Both are idempotent on clients,
// so users whose access did not change are unaffected. Call it after
// publishChannelPermissions: a client that loses the channel it has open
// checks the new permissions while the channel is still in its store.
const publishChannelVisibility = async (channelId: number, userIds: number[]) => {
	if (userIds.length === 0) return;

	const channel = await db.select().from(channels).where(eq(channels.id, channelId)).get();

	if (!channel) return;

	const viewerIds = new Set(await getChannelViewerIds(channelId));
	const canView = userIds.filter((userId) => viewerIds.has(userId));
	const cannotView = userIds.filter((userId) => !viewerIds.has(userId));

	if (canView.length > 0) {
		pubsub.publishFor(canView, ServerEvents.CHANNEL_CREATE, toPublicChannel(channel));
	}

	if (cannotView.length > 0) {
		pubsub.publishFor(cannotView, ServerEvents.CHANNEL_DELETE, channelId);
	}
};

// Same convergence for a change to the users themselves (role added, removed or
// deleted), which can change their access to every private channel at once.
const publishUserChannelVisibility = async (userIds: number[]) => {
	if (userIds.length === 0) return;

	const privateChannels = await db.select({ id: channels.id }).from(channels).where(eq(channels.private, true));

	if (privateChannels.length === 0) return;

	await Promise.all(
		userIds.map(async (userId) => {
			const visibleChannels = await getChannelsForUser(userId);
			const visibleChannelIds = new Set(visibleChannels.map((channel) => channel.id));

			for (const channel of visibleChannels) {
				if (!channel.private) continue;

				pubsub.publishFor(userId, ServerEvents.CHANNEL_CREATE, toPublicChannel(channel));
			}

			for (const { id } of privateChannels) {
				if (visibleChannelIds.has(id)) continue;

				pubsub.publishFor(userId, ServerEvents.CHANNEL_DELETE, id);
			}
		}),
	);
};

const publishSettings = async () => {
	const settings = await getPublicSettings();

	pubsub.publish(ServerEvents.SERVER_SETTINGS_UPDATE, settings);
};

const publishCategory = async (categoryId: number | undefined, type: 'create' | 'update' | 'delete') => {
	if (!categoryId) return;

	if (type === 'delete') {
		pubsub.publish(ServerEvents.CATEGORY_DELETE, categoryId);
		return;
	}

	const category = await db.select().from(categories).where(eq(categories.id, categoryId)).get();

	if (!category) return;

	const targetEvent = type === 'create' ? ServerEvents.CATEGORY_CREATE : ServerEvents.CATEGORY_UPDATE;

	pubsub.publish(targetEvent, category);
};

const publishChannelPermissions = async (affectedUserIds: number[]) => {
	const permissionsMap = new Map<number, TChannelUserPermissionsMap>();
	const promises = affectedUserIds.map(async (userId) => {
		const updatedPermissions = await getAllChannelUserPermissions(userId);

		permissionsMap.set(userId, updatedPermissions);
	});

	await Promise.all(promises);

	for (const userId of affectedUserIds) {
		const updatedPermissions = permissionsMap.get(userId);

		if (!updatedPermissions) continue;

		pubsub.publishFor(userId, ServerEvents.CHANNEL_PERMISSIONS_UPDATE, updatedPermissions);
	}
};

const publishPluginCommands = async () => {
	const commands = pluginManager.getCommands();

	pubsub.publish(ServerEvents.PLUGIN_COMMANDS_CHANGE, commands);
};

export {
	publishCategory,
	publishChannel,
	publishChannelPermissions,
	publishChannelVisibility,
	publishEmoji,
	publishMessage,
	publishPluginCommands,
	publishRole,
	publishSettings,
	publishUser,
	publishUserChannelVisibility,
};
