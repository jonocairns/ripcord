import { ChannelPermission, OWNER_ROLE_ID, Permission } from '@sharkord/shared';
import { useCallback, useMemo } from 'react';
import { useChannelById, useChannelPermissionsById } from './channels/hooks';
import { channelReadStateByIdSelector } from './channels/selectors';
import { useServerStore } from './slice';
import {
  connectedSelector,
  connectingSelector,
  disconnectInfoSelector,
  infoSelector,
  mustChangePasswordSelector,
  pluginsEnabledSelector,
  publicServerSettingsSelector,
  serverNameSelector
} from './selectors';
import type { TVoiceUser } from './types';
import { voiceChannelStateSelector } from './voice/selectors';

const EMPTY_TYPING_USERS: number[] = [];
const EMPTY_VOICE_USERS: TVoiceUser[] = [];

export const useIsConnected = () => useServerStore(connectedSelector);

export const useIsConnecting = () => useServerStore(connectingSelector);

export const useMustChangePassword = () =>
  useServerStore(mustChangePasswordSelector);

export const useDisconnectInfo = () => useServerStore(disconnectInfoSelector);

export const useServerName = () => useServerStore(serverNameSelector);

export const usePublicServerSettings = () =>
  useServerStore(publicServerSettingsSelector);

export const useOwnUserRoles = () => {
  const roles = useServerStore((state) => state.roles);
  const ownUser = useServerStore((state) =>
    state.users.find((user) => user.id === state.ownUserId)
  );

  return useMemo(() => {
    if (!ownUser?.roleIds) {
      return [];
    }

    return roles.filter((role) => ownUser.roleIds.includes(role.id));
  }, [ownUser, roles]);
};

export const useInfo = () => useServerStore(infoSelector);

export const useIsOwnUserOwner = () => {
  const ownUserRoles = useOwnUserRoles();

  return useMemo(
    () => ownUserRoles.some((role) => role.id === OWNER_ROLE_ID),
    [ownUserRoles]
  );
};

export const usePluginsEnabled = () => useServerStore(pluginsEnabledSelector);

export const useCan = () => {
  const ownUserRoles = useOwnUserRoles();
  const isOwner = useIsOwnUserOwner();

  // TODO: maybe this can can recieve both Permission and ChannelPermission?
  const can = useCallback(
    (permission: Permission | Permission[]) => {
      if (isOwner) return true;

      const permissionsToCheck = Array.isArray(permission)
        ? permission
        : [permission];

      for (const role of ownUserRoles) {
        for (const perm of role.permissions) {
          if (permissionsToCheck.includes(perm)) {
            return true;
          }
        }
      }

      return false;
    },
    [ownUserRoles, isOwner]
  );

  return can;
};

export const useChannelCan = (channelId: number | undefined) => {
  const ownUserRoles = useChannelPermissionsById(channelId || -1);
  const isOwner = useIsOwnUserOwner();
  const channel = useChannelById(channelId || -1);

  const can = useCallback(
    (permission: ChannelPermission) => {
      if (isOwner || !channel || !channel.private) return true;

      const permissions = ownUserRoles.permissions ?? {};

      // if VIEW is false, no other permission matters
      if (permissions[ChannelPermission.VIEW_CHANNEL] === false) {
        return false;
      }

      return permissions[permission] === true;
    },
    [ownUserRoles, isOwner, channel]
  );

  return can;
};

export const useUserRoles = (userId: number) => {
  const roles = useServerStore((state) => state.roles);
  const user = useServerStore((state) =>
    state.users.find((entry) => entry.id === userId)
  );

  return useMemo(() => {
    if (!user?.roleIds) {
      return [];
    }

    return roles.filter((role) => user.roleIds.includes(role.id));
  }, [roles, user]);
};

export const useTypingUsersByChannelId = (channelId: number) => {
  const typingUsers = useServerStore(
    (state) => state.typingMap[channelId] ?? EMPTY_TYPING_USERS
  );
  const ownUserId = useServerStore((state) => state.ownUserId);
  const users = useServerStore((state) => state.users);

  return useMemo(
    () =>
      typingUsers
        .filter((userId) => userId !== ownUserId)
        .map((userId) => users.find((user) => user.id === userId))
        .filter((user): user is NonNullable<typeof user> => !!user),
    [ownUserId, typingUsers, users]
  );
};

export const useVoiceUsersByChannelId = (channelId: number) => {
  const users = useServerStore((state) => state.users);
  const voiceState = useServerStore((state) =>
    voiceChannelStateSelector(state, channelId)
  );

  return useMemo(() => {
    if (!voiceState) {
      return EMPTY_VOICE_USERS;
    }

    return Object.entries(voiceState.users).reduce<TVoiceUser[]>(
      (voiceUsers, [userIdStr, userState]) => {
        const userId = Number(userIdStr);
        const user = users.find((entry) => entry.id === userId);

        if (!user) {
          return voiceUsers;
        }

        voiceUsers.push({
          ...user,
          state: userState
        });

        return voiceUsers;
      },
      []
    );
  }, [users, voiceState]);
};

export const useOwnVoiceUser = () => {
  const ownUserId = useServerStore((state) => state.ownUserId);
  const currentVoiceChannelId = useServerStore(
    (state) => state.currentVoiceChannelId
  );
  const voiceUsers = useVoiceUsersByChannelId(currentVoiceChannelId ?? -1);

  return useMemo(() => {
    if (currentVoiceChannelId === undefined) {
      return undefined;
    }

    return voiceUsers.find((voiceUser) => voiceUser.id === ownUserId);
  }, [currentVoiceChannelId, ownUserId, voiceUsers]);
};

export const useUnreadMessagesCount = (channelId: number) =>
  useServerStore((state) => channelReadStateByIdSelector(state, channelId));
