import {
  OWNER_ROLE_ID,
  type Permission,
  type TJoinedPublicUser,
  type TJoinedUser,
  type TStorageData
} from '@sharkord/shared';
import { count, eq, or, sum } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import jwt from 'jsonwebtoken';
import { db } from '..';
import { zTokenPayload } from '../../types';
import { files, rolePermissions, userRoles, users } from '../schema';
import { getServerToken } from './server';

const getPublicUserById = async (
  userId: number
): Promise<TJoinedPublicUser | undefined> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const results = await db
    .select({
      id: users.id,
      name: users.name,
      bannerColor: users.bannerColor,
      bio: users.bio,
      banned: users.banned,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      avatar: avatarFiles,
      banner: bannerFiles,
      createdAt: users.createdAt
    })
    .from(users)
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(eq(users.id, userId))
    .get();

  if (!results) return undefined;

  const roles = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .all();

  return {
    id: results.id,
    name: results.name,
    bannerColor: results.bannerColor,
    bio: results.bio,
    avatarId: results.avatarId,
    bannerId: results.bannerId,
    avatar: results.avatar,
    banner: results.banner,
    createdAt: results.createdAt,
    banned: results.banned,
    roleIds: roles.map((r) => r.roleId)
  };
};

const getPublicUsers = async (
  returnIdentity: boolean = false
): Promise<TJoinedPublicUser[]> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      bannerColor: users.bannerColor,
      bio: users.bio,
      banned: users.banned,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      avatar: avatarFiles,
      banner: bannerFiles,
      createdAt: users.createdAt,
      _identity: users.identity,
      roleId: userRoles.roleId
    })
    .from(users)
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .leftJoin(userRoles, eq(users.id, userRoles.userId))
    .all();

  const usersMap = new Map<number, TJoinedPublicUser>();
  for (const row of rows) {
    const existing = usersMap.get(row.id);
    if (existing) {
      if (row.roleId !== null) existing.roleIds.push(row.roleId);
    } else {
      usersMap.set(row.id, {
        id: row.id,
        name: row.name,
        bannerColor: row.bannerColor,
        bio: row.bio,
        banned: row.banned,
        avatarId: row.avatarId,
        bannerId: row.bannerId,
        avatar: row.avatar,
        banner: row.banner,
        createdAt: row.createdAt,
        ...(returnIdentity ? { _identity: row._identity } : {}),
        roleIds: row.roleId !== null ? [row.roleId] : []
      });
    }
  }

  return Array.from(usersMap.values());
};

const getStorageUsageByUserId = async (
  userId: number
): Promise<TStorageData> => {
  const result = await db
    .select({
      fileCount: count(files.id),
      usedStorage: sum(files.size)
    })
    .from(files)
    .where(eq(files.userId, userId))
    .get();

  return {
    userId,
    fileCount: result?.fileCount ?? 0,
    usedStorage: Number(result?.usedStorage ?? 0)
  };
};

const getUserById = async (
  userId: number
): Promise<TJoinedUser | undefined> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const user = await db
    .select({
      id: users.id,
      identity: users.identity,
      name: users.name,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      bio: users.bio,
      password: users.password,
      bannerColor: users.bannerColor,
      presenceStatus: users.presenceStatus,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      lastLoginAt: users.lastLoginAt,
      tokenVersion: users.tokenVersion,
      mustChangePassword: users.mustChangePassword,
      banned: users.banned,
      banReason: users.banReason,
      bannedAt: users.bannedAt,
      avatar: avatarFiles,
      banner: bannerFiles
    })
    .from(users)
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(eq(users.id, userId))
    .get();

  if (!user) return undefined;

  const roles = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .all();

  return {
    ...user,
    avatar: user.avatar,
    banner: user.banner,
    roleIds: roles.map((r) => r.roleId)
  };
};

const getUserByIdentity = async (
  identity: string
): Promise<TJoinedUser | undefined> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const user = await db
    .select({
      id: users.id,
      identity: users.identity,
      name: users.name,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      bio: users.bio,
      bannerColor: users.bannerColor,
      presenceStatus: users.presenceStatus,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      password: users.password,
      lastLoginAt: users.lastLoginAt,
      tokenVersion: users.tokenVersion,
      mustChangePassword: users.mustChangePassword,
      banned: users.banned,
      banReason: users.banReason,
      bannedAt: users.bannedAt,
      avatar: avatarFiles,
      banner: bannerFiles
    })
    .from(users)
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(eq(users.identity, identity))
    .get();

  if (!user) return undefined;

  const roles = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.userId, user.id))
    .all();

  return {
    ...user,
    avatar: user.avatar,
    banner: user.banner,
    roleIds: roles.map((r) => r.roleId)
  };
};

const getUserByToken = async (token: string | undefined) => {
  try {
    if (!token) return undefined;

    const decoded = zTokenPayload.parse(
      jwt.verify(token, await getServerToken())
    );

    const user = await getUserById(decoded.userId);

    if (!user) return undefined;
    if (decoded.tokenVersion !== user.tokenVersion) return undefined;

    return user;
  } catch {
    return undefined;
  }
};

const getUsers = async (): Promise<TJoinedUser[]> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      bannerColor: users.bannerColor,
      bio: users.bio,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      updatedAt: users.updatedAt,
      createdAt: users.createdAt,
      identity: users.identity,
      password: users.password,
      lastLoginAt: users.lastLoginAt,
      presenceStatus: users.presenceStatus,
      tokenVersion: users.tokenVersion,
      mustChangePassword: users.mustChangePassword,
      banned: users.banned,
      banReason: users.banReason,
      bannedAt: users.bannedAt,
      avatar: avatarFiles,
      banner: bannerFiles,
      roleId: userRoles.roleId
    })
    .from(users)
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .leftJoin(userRoles, eq(users.id, userRoles.userId))
    .all();

  const usersMap = new Map<number, TJoinedUser>();
  for (const row of rows) {
    const existing = usersMap.get(row.id);
    if (existing) {
      if (row.roleId !== null) existing.roleIds.push(row.roleId);
    } else {
      usersMap.set(row.id, {
        id: row.id,
        name: row.name,
        bannerColor: row.bannerColor,
        bio: row.bio,
        avatarId: row.avatarId,
        bannerId: row.bannerId,
        avatar: row.avatar,
        banner: row.banner,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        identity: row.identity,
        password: row.password,
        lastLoginAt: row.lastLoginAt,
        presenceStatus: row.presenceStatus,
        tokenVersion: row.tokenVersion,
        mustChangePassword: row.mustChangePassword,
        banned: row.banned,
        banReason: row.banReason,
        bannedAt: row.bannedAt,
        roleIds: row.roleId !== null ? [row.roleId] : []
      });
    }
  }

  return Array.from(usersMap.values());
};

const getUserIdsWithPermission = async (
  permission: Permission
): Promise<number[]> => {
  const rows = await db
    .select({
      userId: userRoles.userId
    })
    .from(userRoles)
    .leftJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .where(
      or(
        eq(userRoles.roleId, OWNER_ROLE_ID),
        eq(rolePermissions.permission, permission)
      )
    )
    .groupBy(userRoles.userId)
    .all();

  return rows.map((row) => row.userId);
};

export {
  getPublicUserById,
  getPublicUsers,
  getStorageUsageByUserId,
  getUserById,
  getUserByIdentity,
  getUserByToken,
  getUserIdsWithPermission,
  getUsers
};
