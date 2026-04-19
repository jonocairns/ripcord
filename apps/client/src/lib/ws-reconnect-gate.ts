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

export { getWsReconnectOpenAction, shouldResumeDeferredWsReconnect };
