// Load-failure bookkeeping for one attached file's media element. The element
// is keyed by its URL, so a new token remounts it with a clean state; this state
// lives in its parent and survives that remount.
type TMediaRetryState = {
	// The link whose failure started the last refresh. Each link gets one
	// refresh, so a later link (a later rotation) can recover again, while a
	// refresh that returns the same link cannot loop.
	refreshedUrl?: string;
	refreshing: boolean;
	// The URL that failed for good. A later URL (a newer token) is tried again.
	unavailableUrl?: string;
};

type TMediaLoadErrorResult = {
	state: TMediaRetryState;
	refresh: boolean;
};

const INITIAL_MEDIA_RETRY_STATE: TMediaRetryState = { refreshing: false };

const resolveMediaLoadError = (
	state: TMediaRetryState,
	failedUrl: string,
	hasAccessToken: boolean,
): TMediaLoadErrorResult => {
	// Repeat errors from a load already waiting on its refresh.
	if (state.refreshing) {
		return { state, refresh: false };
	}

	// A tokened link may have been rotated or expired: refresh the channel's
	// tokens once for this link, then render again.
	if (hasAccessToken && failedUrl !== state.refreshedUrl) {
		return { state: { ...state, refreshedUrl: failedUrl, refreshing: true }, refresh: true };
	}

	return { state: { ...state, unavailableUrl: failedUrl }, refresh: false };
};

const finishMediaRefresh = (state: TMediaRetryState): TMediaRetryState => ({ ...state, refreshing: false });

const isMediaUnavailable = (state: TMediaRetryState, url: string): boolean => url === state.unavailableUrl;

export type { TMediaRetryState };
export { finishMediaRefresh, INITIAL_MEDIA_RETRY_STATE, isMediaUnavailable, resolveMediaLoadError };
