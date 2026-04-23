import { type TJoinedPublicUser, UserStatus } from '@sharkord/shared';
import { useServerStore } from '../slice';
import { userByIdSelector } from './selectors';

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
	const status = user.status ?? UserStatus.ONLINE;

	if (foundUser) {
		updateUser(user.id, { ...user, status });
	} else {
		addUser({ ...user, status });
	}
};
