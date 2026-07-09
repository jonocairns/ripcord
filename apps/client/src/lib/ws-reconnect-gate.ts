type TWsReconnectOpenAction = 'ignore' | 'defer' | 'resume';

const getWsReconnectOpenAction = (opts: {
	hasTeardownTimer: boolean;
	isReconnectOnline: boolean;
}): TWsReconnectOpenAction => {
	if (!opts.hasTeardownTimer) {
		return 'ignore';
	}

	return opts.isReconnectOnline ? 'resume' : 'defer';
};

const shouldResumeDeferredWsReconnect = (opts: { hasTeardownTimer: boolean; isSocketOpen: boolean }): boolean => {
	return opts.hasTeardownTimer && opts.isSocketOpen;
};

// While the client is offline the give-up teardown (drop to the disconnect
// screen) must stay pending rather than fire: we already know why we can't reach
// the server, and tearing down mid-offline orphans the reopened socket and drops
// the reconnect-rejoin machinery (teardownTimer doubles as the "re-join needed on
// next open" signal). Keep waiting until we are back online.
const shouldDeferAppTeardownWhileOffline = (isReconnectOnline: boolean): boolean => {
	return !isReconnectOnline;
};

export { getWsReconnectOpenAction, shouldDeferAppTeardownWhileOffline, shouldResumeDeferredWsReconnect };
