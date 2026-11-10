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

// While offline, keep recovery pending rather than showing a disconnect screen
// that cannot help without a network. Preserve the deferred rejoin machinery and
// teardownTimer's "re-join needed on next open" signal until we are back online.
const shouldDeferAppTeardownWhileOffline = (isReconnectOnline: boolean): boolean => {
	return !isReconnectOnline;
};

export { getWsReconnectOpenAction, shouldDeferAppTeardownWhileOffline, shouldResumeDeferredWsReconnect };
