import {
	ChannelPermission,
	type TChannel,
	type TChannelUserPermissionsMap,
	type TReadStateMap,
} from '@sharkord/shared';
import { and, eq, sql } from 'drizzle-orm';
import { canViewChannel, resolveChannelGrant, type TChannelGrants } from '../../utils/permission-policy';
import { db } from '..';
import { channelReadStates, channels, messages, users } from '../schema';
import { loadChannelGrantsForUser, loadPrivateViewGrantsForUsers, loadUserGrantsForChannel } from './permissions';

const grantsFor = (channel: TChannel, byChannel: ReadonlyMap<number, TChannelGrants>): TChannelGrants => ({
	private: channel.private,
	user: byChannel.get(channel.id)?.user ?? [],
	roles: byChannel.get(channel.id)?.roles ?? [],
});

export const getChannelsForUser = async (userId: number, channelRows?: TChannel[]): Promise<TChannel[]> => {
	const { isOwner, byChannel } = loadChannelGrantsForUser(userId);
	const allChannels = channelRows ?? db.select().from(channels).all();
	return allChannels.filter((channel) => canViewChannel(isOwner, grantsFor(channel, byChannel)));
};

export const getAllChannelUserPermissions = async (
	userId: number,
	channelRows?: TChannel[],
): Promise<TChannelUserPermissionsMap> => {
	const { isOwner, byChannel } = loadChannelGrantsForUser(userId);
	const allChannels = channelRows ?? db.select().from(channels).all();
	const result: TChannelUserPermissionsMap = {};
	for (const channel of allChannels) {
		const grants = grantsFor(channel, byChannel);
		const allowed = (permission: ChannelPermission) => isOwner || resolveChannelGrant(grants, permission);
		result[channel.id] = {
			channelId: channel.id,
			permissions: {
				[ChannelPermission.VIEW_CHANNEL]: allowed(ChannelPermission.VIEW_CHANNEL),
				[ChannelPermission.SEND_MESSAGES]: allowed(ChannelPermission.SEND_MESSAGES),
				[ChannelPermission.JOIN]: allowed(ChannelPermission.JOIN),
				[ChannelPermission.SPEAK]: allowed(ChannelPermission.SPEAK),
				[ChannelPermission.WEBCAM]: allowed(ChannelPermission.WEBCAM),
				[ChannelPermission.SHARE_SCREEN]: allowed(ChannelPermission.SHARE_SCREEN),
			},
		};
	}
	return result;
};

const allUserIds = () =>
	db
		.select({ id: users.id })
		.from(users)
		.all()
		.map((user) => user.id);

export const getChannelViewerIdsSync = (channelId: number): number[] | undefined => {
	const snapshot = loadUserGrantsForChannel(channelId, ChannelPermission.VIEW_CHANNEL);
	if (!snapshot) return undefined;
	if (!snapshot.channel.private) return allUserIds();
	const viewers = new Set(snapshot.ownerIds);
	for (const [userId, grants] of snapshot.byUser) {
		if (canViewChannel(snapshot.ownerIds.has(userId), grants)) viewers.add(userId);
	}
	return [...viewers];
};

export const getChannelViewerIds = async (channelId: number): Promise<number[]> =>
	getChannelViewerIdsSync(channelId) ?? [];

export const getChannelOverrideSubjectIds = async (channelId: number): Promise<number[]> => {
	const snapshot = loadUserGrantsForChannel(channelId);
	if (!snapshot) return [];
	if (!snapshot.channel.private) return allUserIds();
	// These users' permission maps may have changed, including users who just lost access.
	return [...new Set([...snapshot.byUser.keys(), ...snapshot.ownerIds])];
};

// Resolve both sides of role changes with the same synchronous viewer rules used
// by live publishers. Snapshot before mutating roles; never await while resolving.
export const getVisiblePrivateChannelIdsByUserSync = (userIds: number[]): Map<number, Set<number>> => {
	const { byUser, channelIds, ownerIds } = loadPrivateViewGrantsForUsers(userIds);
	const result = new Map<number, Set<number>>();
	for (const [userId, byChannel] of byUser) {
		const visible = new Set<number>();
		for (const channelId of channelIds) {
			if (canViewChannel(ownerIds.has(userId), byChannel.get(channelId) ?? { private: true, user: [], roles: [] }))
				visible.add(channelId);
		}
		result.set(userId, visible);
	}
	return result;
};

const selectUnreadCounts = (userId: number, channelId?: number) =>
	db
		.select({
			channelId: messages.channelId,
			unreadCount: sql<number>`
        COUNT(CASE
          WHEN ${messages.userId} != ${userId}
            AND (${channelReadStates.lastReadMessageId} IS NULL
              OR ${messages.id} > ${channelReadStates.lastReadMessageId})
          THEN 1
        END)
      `.as('unread_count'),
		})
		.from(messages)
		.leftJoin(
			channelReadStates,
			and(eq(channelReadStates.channelId, messages.channelId), eq(channelReadStates.userId, userId)),
		)
		.where(channelId ? eq(messages.channelId, channelId) : undefined)
		.groupBy(messages.channelId);

// Synchronous so visibility publishers can send the count without yielding
// between resolving access and publishing it.
export const getChannelUnreadCountSync = (userId: number, channelId: number): number =>
	selectUnreadCounts(userId, channelId).get()?.unreadCount ?? 0;

const getChannelsReadStatesForUser = async (userId: number, channelId?: number): Promise<TReadStateMap> => {
	const results = await selectUnreadCounts(userId, channelId);

	const readStateMap: TReadStateMap = {};

	for (const result of results) {
		readStateMap[result.channelId] = result.unreadCount;
	}

	return readStateMap;
};

export { getChannelsReadStatesForUser };
