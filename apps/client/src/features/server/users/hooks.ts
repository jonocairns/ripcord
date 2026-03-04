import { useServerStore } from '../slice';
import {
  isOwnUserSelector,
  ownPublicUserSelector,
  ownUserIdSelector,
  ownUserSelector,
  userByIdSelector,
  usernamesSelector,
  usersSelector,
  userStatusSelector
} from './selectors';

export const useUsers = () => useServerStore(usersSelector);

export const useOwnUser = () => useServerStore(ownUserSelector);

export const useOwnUserId = () => useServerStore(ownUserIdSelector);

export const useIsOwnUser = (userId: number) =>
  useServerStore((state) => isOwnUserSelector(state, userId));

export const useUserById = (userId: number) =>
  useServerStore((state) => userByIdSelector(state, userId));

export const useOwnPublicUser = () =>
  useServerStore(ownPublicUserSelector);

export const useUserStatus = (userId: number) =>
  useServerStore((state) => userStatusSelector(state, userId));

export const useUsernames = () => useServerStore(usernamesSelector);
