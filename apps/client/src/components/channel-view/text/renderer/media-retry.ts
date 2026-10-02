// Load-failure bookkeeping for one attached file's media element. The element
// is keyed by its URL, so a new token remounts it with a clean state; this state
// lives in its parent and survives that remount.
type TMediaRetryState = {
	// Each element gets one refresh, on its first tokened failure.
	retried: boolean;
	refreshing: boolean;
	// The URL that failed for good. A later URL (a newer token) is tried again.
	unavailableUrl?: string;
};

type TMediaLoadErrorResult = {
	state: TMediaRetryState;
	refresh: boolean;
};

const INITIAL_MEDIA_RETRY_STATE: TMediaRetryState = { retried: false, refreshing: false };

const resolveMediaLoadError = (
	state: TMediaRetryState,
	failedUrl: string,
	hasAccessToken: boolean,
): TMediaLoadErrorResult => {
	// Repeat errors from an element already waiting on its refresh.
	if (state.refreshing) {
		return { state, refresh: false };
	}

	// A tokened link may have been rotated or expired: refresh the channel's
	// tokens once, then render again.
	if (hasAccessToken && !state.retried) {
		return { state: { ...state, retried: true, refreshing: true }, refresh: true };
	}

	return { state: { ...state, unavailableUrl: failedUrl }, refresh: false };
};

const finishMediaRefresh = (state: TMediaRetryState): TMediaRetryState => ({ ...state, refreshing: false });

const isMediaUnavailable = (state: TMediaRetryState, url: string): boolean => url === state.unavailableUrl;

export type { TMediaRetryState };
export { finishMediaRefresh, INITIAL_MEDIA_RETRY_STATE, isMediaUnavailable, resolveMediaLoadError };
