import { UserStatus, type TJoinedPublicUser } from '@sharkord/shared';
import type { IServerState } from '../slice';

const STATUS_ORDER: Record<string, number> = {
  online: 0,
  idle: 1,
  offline: 2
};

let lastUsersInput: IServerState['users'] | undefined;
let lastSortedUsers: TJoinedPublicUser[] = [];
let lastUsernamesInput: TJoinedPublicUser[] | undefined;
let lastUsernames: Record<number, string> = {};

export const ownUserIdSelector = (state: IServerState) => state.ownUserId;

export const usersSelector = (state: IServerState) => {
  if (state.users === lastUsersInput) {
    return lastSortedUsers;
  }

  lastUsersInput = state.users;
  lastSortedUsers = [...state.users].sort((a, b) => {
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

  return lastSortedUsers;
};

export const ownUserSelector = (state: IServerState) =>
  usersSelector(state).find((user) => user.id === ownUserIdSelector(state));

export const userByIdSelector = (state: IServerState, userId: number) =>
  usersSelector(state).find((user) => user.id === userId);

export const isOwnUserSelector = (state: IServerState, userId: number) =>
  ownUserIdSelector(state) === userId;

export const ownPublicUserSelector = (state: IServerState) =>
  usersSelector(state).find((user) => user.id === ownUserIdSelector(state));

export const userStatusSelector = (state: IServerState, userId: number) =>
  userByIdSelector(state, userId)?.status ?? UserStatus.OFFLINE;

export const usernamesSelector = (state: IServerState) => {
  const users = usersSelector(state);

  if (users === lastUsernamesInput) {
    return lastUsernames;
  }

  const map: Record<number, string> = {};

  users.forEach((user) => {
    map[user.id] = user.name;
  });

  lastUsernamesInput = users;
  lastUsernames = map;

  return lastUsernames;
};
