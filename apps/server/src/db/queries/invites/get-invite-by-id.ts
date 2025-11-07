import type { TJoinedInvite } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db } from '../..';
import { invites, files, users } from '../../schema';

const getInviteById = async (id: number): Promise<TJoinedInvite | undefined> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const row = await db
    .select({
      invite: invites,
      creator: {
        id: users.id,
        name: users.name,
        roleId: users.roleId,
        bannerColor: users.bannerColor,
        bio: users.bio,
        banned: users.banned,
        createdAt: users.createdAt,
        avatarId: users.avatarId,
        bannerId: users.bannerId
      },
      avatar: avatarFiles,
      banner: bannerFiles
    })
    .from(invites)
    .innerJoin(users, eq(invites.creatorId, users.id))
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(eq(invites.id, id))
    .limit(1)
    .get();

  if (!row) return undefined;

  return {
    ...row.invite,
    creator: {
      ...row.creator,
      avatar: row.avatar,
      banner: row.banner
    }
  };
};

export { getInviteById };
