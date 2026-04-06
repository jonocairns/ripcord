import { type TJoinedPublicUser, UserStatus } from '@sharkord/shared';
import { getTRPCClient } from '@/lib/trpc';
import { bufferReconnectSnapshotEvent } from '../reconnect-event-buffer';
import { addUser, handleUserJoin, removeUser, updateUser } from './actions';

const subscribeToUsers = ({ canSubscribeToDelete = false } = {}) => {
	const trpc = getTRPCClient();

	const onUserJoinSub = trpc.users.onJoin.subscribe(undefined, {
		onData: (user: TJoinedPublicUser) => {
			const apply = () => {
				handleUserJoin(user);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onUserJoin subscription error:', err),
	});

	const onUserCreateSub = trpc.users.onCreate.subscribe(undefined, {
		onData: (user: TJoinedPublicUser) => {
			const apply = () => {
				addUser(user);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onUserCreate subscription error:', err),
	});

	const onUserLeaveSub = trpc.users.onLeave.subscribe(undefined, {
		onData: (userId: number) => {
			const apply = () => {
				updateUser(userId, { status: UserStatus.OFFLINE });
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onUserLeave subscription error:', err),
	});

	const onUserUpdateSub = trpc.users.onUpdate.subscribe(undefined, {
		onData: (user: TJoinedPublicUser) => {
			const apply = () => {
				updateUser(user.id, user);
			};

			if (!bufferReconnectSnapshotEvent(apply)) {
				apply();
			}
		},
		onError: (err) => console.error('onUserUpdate subscription error:', err),
	});

	const onUserDeleteSub = canSubscribeToDelete
		? trpc.users.onDelete.subscribe(undefined, {
				onData: (userId: number) => {
					const apply = () => {
						removeUser(userId);
					};

					if (!bufferReconnectSnapshotEvent(apply)) {
						apply();
					}
				},
				onError: (err) => console.error('onUserDelete subscription error:', err),
			})
		: null;

	return () => {
		onUserJoinSub.unsubscribe();
		onUserLeaveSub.unsubscribe();
		onUserUpdateSub.unsubscribe();
		onUserCreateSub.unsubscribe();
		onUserDeleteSub?.unsubscribe();
	};
};

export { subscribeToUsers };
