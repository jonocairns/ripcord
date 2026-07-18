type TWsRejoinFailureAction = 'cancel-stale' | 'refresh-auth' | 'teardown' | 'wait-for-reconnect';

const resolveWsRejoinFailureAction = ({
	generationChanged,
	isAuthError,
	isSocketOpen,
}: {
	generationChanged: boolean;
	isAuthError: boolean;
	isSocketOpen: boolean;
}): TWsRejoinFailureAction => {
	if (generationChanged) {
		return 'cancel-stale';
	}

	if (!isSocketOpen) {
		return 'wait-for-reconnect';
	}

	if (isAuthError) {
		return 'refresh-auth';
	}

	return 'teardown';
};

export { resolveWsRejoinFailureAction, type TWsRejoinFailureAction };
