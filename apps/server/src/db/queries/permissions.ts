import { OWNER_ROLE_ID, Permission } from '@sharkord/shared';
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
	const permissions = new Set<Permission>();
	for (const row of rows) {
		for (const permission of Object.values(Permission)) {
			if (permission === row.permission) permissions.add(permission);
		}
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
