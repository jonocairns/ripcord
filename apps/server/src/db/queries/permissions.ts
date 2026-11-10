import { ChannelPermission, OWNER_ROLE_ID } from '@sharkord/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { TChannelGrants, TUserGrants } from '../../utils/permission-policy';
import { db } from '..';
import {
	channelRolePermissions,
	channels,
	channelUserPermissions,
	rolePermissions,
	roles,
	userRoles,
	users,
} from '../schema';

// Synchronous snapshots: callers must load again for each operation.
export const loadUserGrants = (userId: number): TUserGrants | undefined => {
	const user = db.select({ banned: users.banned }).from(users).where(eq(users.id, userId)).get();
	if (!user) return undefined;
	const rows = db
		.select({ roleId: roles.id, permission: rolePermissions.permission })
		.from(userRoles)
		.innerJoin(roles, eq(userRoles.roleId, roles.id))
		.leftJoin(rolePermissions, eq(roles.id, rolePermissions.roleId))
		.where(eq(userRoles.userId, userId))
		.all();
	const permissions = new Set<string>();
	for (const row of rows) {
		if (row.permission !== null) permissions.add(row.permission);
	}
	return { banned: user.banned, isOwner: rows.some((row) => row.roleId === OWNER_ROLE_ID), permissions };
};

export const loadChannelGrants = (userId: number, channelId: number): TChannelGrants | undefined => {
	const channel = db.select({ private: channels.private }).from(channels).where(eq(channels.id, channelId)).get();
	if (!channel) return undefined;
	if (!channel.private) return { private: false, user: [], roles: [] };
	const user = db
		.select({ permission: channelUserPermissions.permission, allow: channelUserPermissions.allow })
		.from(channelUserPermissions)
		.where(and(eq(channelUserPermissions.channelId, channelId), eq(channelUserPermissions.userId, userId)))
		.all();
	const roleRows = db
		.select({ permission: channelRolePermissions.permission, allow: channelRolePermissions.allow })
		.from(channelRolePermissions)
		.where(
			and(
				eq(channelRolePermissions.channelId, channelId),
				inArray(
					channelRolePermissions.roleId,
					db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId)),
				),
			),
		)
		.all();
	return { private: true, user, roles: roleRows };
};

type TMutableChannelGrants = {
	private: boolean;
	user: { permission: string; allow: boolean }[];
	roles: { permission: string; allow: boolean }[];
};

const grantsAt = (map: Map<number, TMutableChannelGrants>, id: number): TMutableChannelGrants => {
	let grants = map.get(id);
	if (!grants) {
		grants = { private: true, user: [], roles: [] };
		map.set(id, grants);
	}
	return grants;
};

const loadOwnerIds = (): Set<number> =>
	new Set(
		db
			.select({ userId: userRoles.userId })
			.from(userRoles)
			.where(eq(userRoles.roleId, OWNER_ROLE_ID))
			.all()
			.map((row) => row.userId),
	);

// Listings and fan-out intentionally do not check bans: banned users have no socket.
// Only hasChannelAccess authorizes requests.
export const loadChannelGrantsForUser = (userId: number) => {
	const roleRows = db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId)).all();
	const userRows = db.select().from(channelUserPermissions).where(eq(channelUserPermissions.userId, userId)).all();
	const roleGrants = db
		.select({
			channelId: channelRolePermissions.channelId,
			permission: channelRolePermissions.permission,
			allow: channelRolePermissions.allow,
		})
		.from(channelRolePermissions)
		.innerJoin(userRoles, eq(userRoles.roleId, channelRolePermissions.roleId))
		.where(eq(userRoles.userId, userId))
		.all();
	const byChannel = new Map<number, TMutableChannelGrants>();
	for (const row of userRows) grantsAt(byChannel, row.channelId).user.push(row);
	for (const row of roleGrants) grantsAt(byChannel, row.channelId).roles.push(row);
	return { isOwner: roleRows.some((row) => row.roleId === OWNER_ROLE_ID), byChannel };
};

export const loadUserGrantsForChannel = (channelId: number, permission?: ChannelPermission) => {
	const channel = db.select({ private: channels.private }).from(channels).where(eq(channels.id, channelId)).get();
	if (!channel) return undefined;
	const byUser = new Map<number, TMutableChannelGrants>();
	if (!channel.private) return { channel, byUser, ownerIds: new Set<number>() };
	const userRows = db
		.select()
		.from(channelUserPermissions)
		.where(
			and(
				eq(channelUserPermissions.channelId, channelId),
				permission ? eq(channelUserPermissions.permission, permission) : undefined,
			),
		)
		.all();
	const roleRows = db
		.select({
			userId: userRoles.userId,
			permission: channelRolePermissions.permission,
			allow: channelRolePermissions.allow,
		})
		.from(channelRolePermissions)
		.innerJoin(userRoles, eq(userRoles.roleId, channelRolePermissions.roleId))
		.where(
			and(
				eq(channelRolePermissions.channelId, channelId),
				permission ? eq(channelRolePermissions.permission, permission) : undefined,
			),
		)
		.all();
	for (const row of userRows) grantsAt(byUser, row.userId).user.push(row);
	for (const row of roleRows) grantsAt(byUser, row.userId).roles.push(row);
	return { channel, byUser, ownerIds: loadOwnerIds() };
};

export const loadPrivateViewGrantsForUsers = (userIds: number[]) => {
	const byUser = new Map(userIds.map((id) => [id, new Map<number, TMutableChannelGrants>()]));
	if (userIds.length === 0) return { byUser, channelIds: [], ownerIds: new Set<number>() };
	const channelIds = db
		.select({ id: channels.id })
		.from(channels)
		.where(eq(channels.private, true))
		.all()
		.map((row) => row.id);
	// Filter users in JS rather than binding an unbounded list of ids.
	const userRows = db
		.select()
		.from(channelUserPermissions)
		.where(eq(channelUserPermissions.permission, ChannelPermission.VIEW_CHANNEL))
		.all();
	const roleRows = db
		.select({
			userId: userRoles.userId,
			channelId: channelRolePermissions.channelId,
			permission: channelRolePermissions.permission,
			allow: channelRolePermissions.allow,
		})
		.from(channelRolePermissions)
		.innerJoin(userRoles, eq(userRoles.roleId, channelRolePermissions.roleId))
		.where(eq(channelRolePermissions.permission, ChannelPermission.VIEW_CHANNEL))
		.all();
	const privateIds = new Set(channelIds);
	for (const row of userRows) {
		const map = byUser.get(row.userId);
		if (map && privateIds.has(row.channelId)) grantsAt(map, row.channelId).user.push(row);
	}
	for (const row of roleRows) {
		const map = byUser.get(row.userId);
		if (map && privateIds.has(row.channelId)) grantsAt(map, row.channelId).roles.push(row);
	}
	return { byUser, channelIds, ownerIds: loadOwnerIds() };
};
