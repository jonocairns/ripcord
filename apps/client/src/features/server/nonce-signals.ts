import { fileAccessChangeNonceSelector, serverRejoinNonceSelector } from './selectors';
import { type IServerState, useServerStore } from './slice';

// Calls `onBump` each time the selected nonce increases. A store reset drops it
// back to zero, which is not a bump.
const subscribeToNonceBumps = (selectNonce: (state: IServerState) => number, onBump: () => void) =>
	useServerStore.subscribe((state, previousState) => {
		if (selectNonce(state) > selectNonce(previousState)) {
			onBump();
		}
	});

// File lists kept outside the message store (the moderator sheet) are not
// reached by the message token refresh. They refresh their own links when a
// channel's token rotates, and after a confirmed rejoin, which covers a
// rotation missed while disconnected.
const subscribeToFileListInvalidations = (refresh: () => void) => {
	const unsubscribeFromRejoins = subscribeToNonceBumps(serverRejoinNonceSelector, refresh);
	const unsubscribeFromFileAccessChanges = subscribeToNonceBumps(fileAccessChangeNonceSelector, refresh);

	return () => {
		unsubscribeFromRejoins();
		unsubscribeFromFileAccessChanges();
	};
};

// Changes whenever file links may have been invalidated (a rotation or a
// confirmed rejoin). A response requested under an older version can carry
// links that predate the change.
const getFileLinkVersion = (state: IServerState = useServerStore.getState()) =>
	`${serverRejoinNonceSelector(state)}:${fileAccessChangeNonceSelector(state)}`;

export { getFileLinkVersion, subscribeToFileListInvalidations, subscribeToNonceBumps };
