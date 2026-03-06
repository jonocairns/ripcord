import { UserStatus, type TJoinedPublicUser } from '@sharkord/shared';
import type { IServerState } from '../slice';

const STATUS_ORDER: Record<string, number> = {
  online: 0,
  idle: 1,
  offline: 2
};

export const ownUserIdSelector = (state: IServerState) => state.ownUserId;

export const sortUsers = (users: TJoinedPublicUser[]) => {
  return [...users].sort((a, b) => {
    const aBanned = Boolean(a.banned);
    const bBanned = Boolean(b.banned);

    if (aBanned !== bBanned) {
      return aBanned ? 1 : -1;
    }

    const aStatus = STATUS_ORDER[String(a.status ?? UserStatus.OFFLINE)] ?? 3;
    const bStatus = STATUS_ORDER[String(b.status ?? UserStatus.OFFLINE)] ?? 3;

    if (aStatus !== bStatus) {
      return aStatus - bStatus;
    }

    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
};

export const usersSelector = (state: IServerState) => state.users;

export const ownUserSelector = (state: IServerState) =>
  state.users.find((user) => user.id === ownUserIdSelector(state));

export const userByIdSelector = (state: IServerState, userId: number) =>
  state.users.find((user) => user.id === userId);

export const isOwnUserSelector = (state: IServerState, userId: number) =>
  ownUserIdSelector(state) === userId;

export const userStatusSelector = (state: IServerState, userId: number) =>
  userByIdSelector(state, userId)?.status ?? UserStatus.OFFLINE;

export const toUsernamesMap = (users: TJoinedPublicUser[]) => {
  const map: Record<number, string> = {};

  users.forEach((user) => {
    map[user.id] = user.name;
  });

  return map;
};

export const usernamesSelector = (state: IServerState) =>
  toUsernamesMap(state.users);
