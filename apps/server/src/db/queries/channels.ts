import {
  ChannelPermission,
  OWNER_ROLE_ID,
  type TChannel,
  type TChannelUserPermissionsMap
} from '@sharkord/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '..';
import {
  channelRolePermissions,
  channels,
  channelUserPermissions,
  userRoles,
  users
} from '../schema';
import { getUserRoleIds } from './roles';

const getPermissions = async (
  userId: number,
  roleIds: number[],
  permission: ChannelPermission,
  channelId?: number
) => {
  const userPermissionsQuery = db
    .select({
      channelId: channelUserPermissions.channelId,
      allow: channelUserPermissions.allow
    })
    .from(channelUserPermissions)
    .where(
      and(
        eq(channelUserPermissions.userId, userId),
        eq(channelUserPermissions.permission, permission),
        channelId ? eq(channelUserPermissions.channelId, channelId) : undefined
      )
    );

  let rolePermissionsQuery = null;

  if (roleIds.length > 0) {
    rolePermissionsQuery = db
      .select({
        channelId: channelRolePermissions.channelId,
        allow: channelRolePermissions.allow
      })
      .from(channelRolePermissions)
      .where(
        and(
          inArray(channelRolePermissions.roleId, roleIds),
          eq(channelRolePermissions.permission, permission),
          channelId
            ? eq(channelRolePermissions.channelId, channelId)
            : undefined
        )
      );
  }

  const [userPermissions, rolePermissions] = await Promise.all([
    userPermissionsQuery,
    rolePermissionsQuery || Promise.resolve([])
  ]);

  const userPermissionMap = new Map(
    userPermissions.map((p) => [p.channelId, p.allow])
  );

  const rolePermissionMap = new Map<number, boolean>();

  for (const perm of rolePermissions) {
    const existing = rolePermissionMap.get(perm.channelId);

    rolePermissionMap.set(perm.channelId, existing || perm.allow);
  }

  return { userPermissionMap, rolePermissionMap };
};

const channelUserCan = async (
  channelId: number,
  userId: number,
  permission: ChannelPermission
): Promise<boolean> => {
  const roleIds = await getUserRoleIds(userId);

  if (roleIds.includes(OWNER_ROLE_ID)) {
    return true;
  }

  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) {
    return false;
  }

  if (!channel.private) {
    return true;
  }

  const { userPermissionMap, rolePermissionMap } = await getPermissions(
    userId,
    roleIds,
    permission,
    channelId
  );

  const userPerm = userPermissionMap.get(channelId);

  if (userPerm !== undefined) {
    return userPerm;
  }

  const rolePerm = rolePermissionMap.get(channelId);

  if (rolePerm !== undefined) {
    return rolePerm;
  }

  return false;
};

const getChannelsForUser = async (userId: number): Promise<TChannel[]> => {
  const roleIds = await getUserRoleIds(userId);

  if (roleIds.includes(OWNER_ROLE_ID)) {
    return await db.select().from(channels);
  }

  const allChannels = await db.select().from(channels);

  const { userPermissionMap, rolePermissionMap } = await getPermissions(
    userId,
    roleIds,
    ChannelPermission.VIEW_CHANNEL
  );

  const accessibleChannels = allChannels.filter((channel) => {
    if (!channel.private) {
      return true;
    }

    const userPerm = userPermissionMap.get(channel.id);

    if (userPerm !== undefined) {
      return userPerm;
    }

    const rolePerm = rolePermissionMap.get(channel.id);

    return rolePerm;
  });

  return accessibleChannels;
};

const getAllChannelUserPermissions = async (
  userId: number
): Promise<TChannelUserPermissionsMap> => {
  const roleIds = await getUserRoleIds(userId);
  const allChannels = await db.select().from(channels);

  const userPermissions = await db
    .select({
      channelId: channelUserPermissions.channelId,
      permission: channelUserPermissions.permission,
      allow: channelUserPermissions.allow
    })
    .from(channelUserPermissions)
    .where(eq(channelUserPermissions.userId, userId));

  let rolePermissions: typeof userPermissions = [];

  if (roleIds.length > 0) {
    rolePermissions = await db
      .select({
        channelId: channelRolePermissions.channelId,
        permission: channelRolePermissions.permission,
        allow: channelRolePermissions.allow
      })
      .from(channelRolePermissions)
      .where(inArray(channelRolePermissions.roleId, roleIds));
  }

  const userPermMap = new Map<number, Map<ChannelPermission, boolean>>();

  for (const perm of userPermissions) {
    if (!userPermMap.has(perm.channelId)) {
      userPermMap.set(perm.channelId, new Map());
    }

    userPermMap
      .get(perm.channelId)!
      .set(perm.permission as ChannelPermission, perm.allow);
  }

  const rolePermMap = new Map<number, Map<ChannelPermission, boolean>>();

  for (const perm of rolePermissions) {
    if (!rolePermMap.has(perm.channelId)) {
      rolePermMap.set(perm.channelId, new Map());
    }

    const channelMap = rolePermMap.get(perm.channelId)!;
    const existing = channelMap.get(perm.permission as ChannelPermission);

    channelMap.set(
      perm.permission as ChannelPermission,
      existing || perm.allow
    );
  }

  console.log('User Permission Map:', userPermMap);
  console.log('Role Permission Map:', rolePermMap);

  const allPermissionTypes = Object.values(ChannelPermission);

  const channelPermissions: Record<
    number,
    { channelId: number; permissions: Record<ChannelPermission, boolean> }
  > = {};

  for (const channel of allChannels) {
    const permissions: Record<string, boolean> = {};

    for (const permissionType of allPermissionTypes) {
      const userPerm = userPermMap.get(channel.id)?.get(permissionType);

      if (userPerm !== undefined) {
        permissions[permissionType] = userPerm;

        continue;
      }

      const rolePerm = rolePermMap.get(channel.id)?.get(permissionType);

      if (rolePerm !== undefined) {
        permissions[permissionType] = rolePerm;

        continue;
      }

      permissions[permissionType] = false;
    }

    channelPermissions[channel.id] = {
      channelId: channel.id,
      permissions: permissions as Record<ChannelPermission, boolean>
    };
  }

  return channelPermissions;
};

const getRoleChannelPermissions = async (
  roleId: number,
  channelId: number
): Promise<Record<ChannelPermission, boolean>> => {
  const rolePermissions = await db
    .select({
      permission: channelRolePermissions.permission,
      allow: channelRolePermissions.allow
    })
    .from(channelRolePermissions)
    .where(
      and(
        eq(channelRolePermissions.roleId, roleId),
        eq(channelRolePermissions.channelId, channelId)
      )
    );

  const allPermissionTypes = Object.values(ChannelPermission);
  const permissions: Record<string, boolean> = {};

  const permissionMap = new Map(
    rolePermissions.map((p) => [p.permission as ChannelPermission, p.allow])
  );

  for (const permissionType of allPermissionTypes) {
    permissions[permissionType] = permissionMap.get(permissionType) ?? false;
  }

  return permissions;
};

const getUserChannelPermissions = async (
  userId: number,
  channelId: number
): Promise<Record<ChannelPermission, boolean>> => {
  const userPermissions = await db
    .select({
      permission: channelUserPermissions.permission,
      allow: channelUserPermissions.allow
    })
    .from(channelUserPermissions)
    .where(
      and(
        eq(channelUserPermissions.userId, userId),
        eq(channelUserPermissions.channelId, channelId)
      )
    );

  const allPermissionTypes = Object.values(ChannelPermission);
  const permissions: Record<string, boolean> = {};

  const permissionMap = new Map(
    userPermissions.map((p) => [p.permission as ChannelPermission, p.allow])
  );

  for (const permissionType of allPermissionTypes) {
    permissions[permissionType] = permissionMap.get(permissionType) ?? false;
  }

  return permissions;
};

const getAffectedUserIdsForChannel = async (
  channelId: number,
  forceAllUsers: boolean = false
): Promise<number[]> => {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) {
    return [];
  }

  // if channel is public, return all user IDs
  if (!channel.private || forceAllUsers) {
    const allUsers = await db.select({ id: users.id }).from(users);

    return allUsers.map((user) => user.id);
  }

  const usersWithDirectPerms = await db
    .select({ userId: channelUserPermissions.userId })
    .from(channelUserPermissions)
    .where(eq(channelUserPermissions.channelId, channelId));

  const rolesWithPerms = await db
    .select({ roleId: channelRolePermissions.roleId })
    .from(channelRolePermissions)
    .where(eq(channelRolePermissions.channelId, channelId));

  const roleIds = rolesWithPerms.map((r) => r.roleId);

  let usersWithRoles: { userId: number }[] = [];

  if (roleIds.length > 0) {
    usersWithRoles = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(inArray(userRoles.roleId, roleIds));
  }

  // get users with the owner role because they have access to everything all the time
  const owners = await db
    .select({ id: users.id })
    .from(users)
    .where(
      inArray(
        users.id,
        db
          .select({ userId: userRoles.userId })
          .from(userRoles)
          .where(eq(userRoles.roleId, OWNER_ROLE_ID))
      )
    );

  const userIdSet = new Set<number>();

  usersWithDirectPerms.forEach((u) => userIdSet.add(u.userId));
  usersWithRoles.forEach((u) => userIdSet.add(u.userId));
  owners.forEach((u) => userIdSet.add(u.id));

  return Array.from(userIdSet);
};

export {
  channelUserCan,
  getAffectedUserIdsForChannel,
  getAllChannelUserPermissions,
  getChannelsForUser,
  getRoleChannelPermissions,
  getUserChannelPermissions
};
