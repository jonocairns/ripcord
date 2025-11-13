import { OWNER_ROLE_ID, Permission } from '@sharkord/shared';
import { useCallback } from 'react';
import { useSelector } from 'react-redux';
import type { IRootState } from '../store';
import {
  connectedSelector,
  connectingSelector,
  disconnectInfoSelector,
  infoSelector,
  ownUserRoleSelector,
  publicServerSettingsSelector,
  serverNameSelector,
  typingUsersByChannelIdSelector,
  userRoleSelector,
  voiceUsersByChannelIdSelector
} from './selectors';

export const useIsConnected = () => useSelector(connectedSelector);

export const useIsConnecting = () => useSelector(connectingSelector);

export const useDisconnectInfo = () => useSelector(disconnectInfoSelector);

export const useServerName = () => useSelector(serverNameSelector);

export const usePublicServerSettings = () =>
  useSelector(publicServerSettingsSelector);

export const useOwnUserRole = () => useSelector(ownUserRoleSelector);

export const useInfo = () => useSelector(infoSelector);

export const useCan = () => {
  const ownUserRole = useOwnUserRole();

  const can = useCallback(
    (permission: Permission | Permission[]) => {
      if (!ownUserRole) return false;

      if (ownUserRole.id === OWNER_ROLE_ID) {
        return true;
      }

      if (Array.isArray(permission)) {
        return !!permission.some((perm) =>
          ownUserRole.permissions?.includes(perm)
        );
      }

      return !!ownUserRole.permissions?.includes(permission);
    },
    [ownUserRole]
  );

  return can;
};

export const useUserRole = (userId: number) =>
  useSelector((state: IRootState) => userRoleSelector(state, userId));

export const useTypingUsersByChannelId = (channelId: number) =>
  useSelector((state: IRootState) =>
    typingUsersByChannelIdSelector(state, channelId)
  );

export const useVoiceUsersByChannelId = (channelId: number) =>
  useSelector((state: IRootState) =>
    voiceUsersByChannelIdSelector(state, channelId)
  );
