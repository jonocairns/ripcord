import { useMemo } from 'react';
import { useServerStore } from '../slice';
import {
	isOwnUserSelector,
	ownUserIdSelector,
	ownUserSelector,
	sortUsers,
	toUsernamesMap,
	userByIdSelector,
	userStatusSelector,
	usersSelector,
} from './selectors';

export const useUsers = () => {
	const users = useServerStore(usersSelector);

	return useMemo(() => sortUsers(users), [users]);
};

export const useOwnUser = () => useServerStore(ownUserSelector);

export const useOwnUserId = () => useServerStore(ownUserIdSelector);

export const useIsOwnUser = (userId: number) => useServerStore((state) => isOwnUserSelector(state, userId));

export const useUserById = (userId: number) => useServerStore((state) => userByIdSelector(state, userId));

export const useOwnPublicUser = () => useServerStore(ownUserSelector);

export const useUserStatus = (userId: number) => useServerStore((state) => userStatusSelector(state, userId));

export const useUsernames = () => {
	const users = useServerStore(usersSelector);

	return useMemo(() => toUsernamesMap(users), [users]);
};
