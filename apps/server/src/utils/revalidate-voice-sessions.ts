import {
  ChannelPermission,
  OWNER_ROLE_ID,
  Permission,
  ServerEvents
} from '@sharkord/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { getAllChannelUserPermissions } from '../db/queries/channels';
import { getUserById } from '../db/queries/users';
import { channels } from '../db/schema';
import { getUserRoles } from '../routers/users/get-user-roles';
import { VoiceRuntime } from '../runtimes/voice';
import { pubsub } from './pubsub';

const hasPermission = async (
  userId: number,
  targetPermission: Permission
): Promise<boolean> => {
  const user = await getUserById(userId);

  if (!user || user.banned) {
    return false;
  }

  const roles = await getUserRoles(user.id);

  if (roles.some((role) => role.id === OWNER_ROLE_ID)) {
    return true;
  }

  return roles.some((role) => role.permissions.includes(targetPermission));
};

const hasChannelPermission = async (
  userId: number,
  channelId: number,
  targetPermission: ChannelPermission
): Promise<boolean> => {
  const channel = await db
    .select({
      private: channels.private
    })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1)
    .get();

  if (!channel) {
    return false;
  }

  if (!channel.private) {
    return true;
  }

  const user = await getUserById(userId);

  if (!user || user.banned) {
    return false;
  }

  const roles = await getUserRoles(user.id);

  if (roles.some((role) => role.id === OWNER_ROLE_ID)) {
    return true;
  }

  const userChannelPermissions = await getAllChannelUserPermissions(userId);
  const channelInfo = userChannelPermissions[channelId];

  if (!channelInfo) {
    return false;
  }

  if (!channelInfo.permissions[ChannelPermission.VIEW_CHANNEL]) {
    return false;
  }

  return channelInfo.permissions[targetPermission] === true;
};

const canUserRemainInVoiceChannel = async (
  userId: number,
  channelId: number
): Promise<boolean> => {
  const [canJoinVoiceChannels, canViewChannel, canJoinChannel, canSpeak] =
    await Promise.all([
      hasPermission(userId, Permission.JOIN_VOICE_CHANNELS),
      hasChannelPermission(userId, channelId, ChannelPermission.VIEW_CHANNEL),
      hasChannelPermission(userId, channelId, ChannelPermission.JOIN),
      hasChannelPermission(userId, channelId, ChannelPermission.SPEAK)
    ]);

  return canJoinVoiceChannels && canViewChannel && canJoinChannel && canSpeak;
};

const revalidateActiveVoiceSessions = async (options?: {
  userIds?: number[];
  channelIds?: number[];
}): Promise<void> => {
  const userIdSet =
    options?.userIds && options.userIds.length > 0
      ? new Set(options.userIds)
      : undefined;
  const channelIdSet =
    options?.channelIds && options.channelIds.length > 0
      ? new Set(options.channelIds)
      : undefined;

  for (const runtime of VoiceRuntime.getAll()) {
    if (channelIdSet && !channelIdSet.has(runtime.id)) {
      continue;
    }

    const activeUsers = [...runtime.getState().users];

    for (const activeUser of activeUsers) {
      if (userIdSet && !userIdSet.has(activeUser.userId)) {
        continue;
      }

      const canRemain = await canUserRemainInVoiceChannel(
        activeUser.userId,
        runtime.id
      );

      if (canRemain) {
        continue;
      }

      runtime.removeUser(activeUser.userId);

      pubsub.publish(ServerEvents.USER_LEAVE_VOICE, {
        channelId: runtime.id,
        userId: activeUser.userId
      });
    }
  }
};

export { revalidateActiveVoiceSessions };
