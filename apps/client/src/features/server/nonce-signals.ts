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

// File lists kept outside the message store (the moderator sheet) cannot be
// patched by the message token refresh. They refetch when a channel's file
// links change, and after a confirmed rejoin, which covers changes missed while
// disconnected.
const subscribeToFileListInvalidations = (refetch: () => void) => {
	const unsubscribeFromRejoins = subscribeToNonceBumps(serverRejoinNonceSelector, refetch);
	const unsubscribeFromFileAccessChanges = subscribeToNonceBumps(fileAccessChangeNonceSelector, refetch);

	return () => {
		unsubscribeFromRejoins();
		unsubscribeFromFileAccessChanges();
	};
};

export { subscribeToFileListInvalidations, subscribeToNonceBumps };
