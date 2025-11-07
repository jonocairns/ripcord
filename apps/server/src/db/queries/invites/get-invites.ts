import type { TJoinedInvite } from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db } from '../..';
import { invites, files, users } from '../../schema';

const getInvites = async (): Promise<TJoinedInvite[]> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const rows = await db
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
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id));

  return rows.map((row) => ({
    ...row.invite,
    creator: {
      ...row.creator,
      avatar: row.avatar,
      banner: row.banner
    }
  }));
};

export { getInvites };