import { type TJoinedPublicUser, UserStatus } from '@sharkord/shared';
import { useServerStore } from '../slice';
import { userByIdSelector } from './selectors';

export const setUsers = (users: TJoinedPublicUser[]) => {
	useServerStore.getState().setUsers(users);
};

export const addUser = (user: TJoinedPublicUser) => {
	useServerStore.getState().addUser(user);
};

export const removeUser = (userId: number) => {
	useServerStore.getState().removeUser({ userId });
};

export const updateUser = (userId: number, user: Partial<TJoinedPublicUser>) => {
	useServerStore.getState().updateUser({ userId, user });
};

export const handleUserJoin = (user: TJoinedPublicUser) => {
	const state = useServerStore.getState();
	const foundUser = userByIdSelector(state, user.id);

	if (foundUser) {
		updateUser(user.id, { ...user, status: UserStatus.ONLINE });
	} else {
		addUser(user);
	}
};
