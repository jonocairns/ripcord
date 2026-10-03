// Source and load-failure bookkeeping for one attached file's media player.
// The player is keyed by its source URL, so a new source remounts it with a
// clean error state; this state lives in its parent and survives that remount.
type TMediaRetryState = {
	// The URL the player loaded successfully. It stays on it when a refresh
	// changes the stored link, so healthy media does not reload or restart. The
	// stored URL is used before a first load and after a failure.
	loadedUrl?: string;
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

const getMediaSrc = (state: TMediaRetryState, storedUrl: string): string => state.loadedUrl ?? storedUrl;

const markMediaLoaded = (state: TMediaRetryState, url: string): TMediaRetryState =>
	state.loadedUrl === url ? state : { ...state, loadedUrl: url };

const resolveMediaLoadError = (
	state: TMediaRetryState,
	failedUrl: string,
	storedUrl: string,
	hasAccessToken: boolean,
): TMediaLoadErrorResult => {
	// Repeat errors from a load already waiting on its refresh.
	if (state.refreshing) {
		return { state, refresh: false };
	}

	// A failed player gives up the link it loaded with.
	const released: TMediaRetryState = { ...state, loadedUrl: undefined };

	// The store already holds a newer link (a refresh landed while the player
	// kept its old one): try that before asking the server again.
	if (storedUrl !== failedUrl) {
		return { state: released, refresh: false };
	}

	// A tokened link may have been rotated or expired: refresh the tokens once
	// for this link, then render again.
	if (hasAccessToken && failedUrl !== state.refreshedUrl) {
		return { state: { ...released, refreshedUrl: failedUrl, refreshing: true }, refresh: true };
	}

	return { state: { ...released, unavailableUrl: failedUrl }, refresh: false };
};

const finishMediaRefresh = (state: TMediaRetryState): TMediaRetryState => ({ ...state, refreshing: false });

const isMediaUnavailable = (state: TMediaRetryState, src: string): boolean => src === state.unavailableUrl;

export type { TMediaRetryState };
export {
	finishMediaRefresh,
	getMediaSrc,
	INITIAL_MEDIA_RETRY_STATE,
	isMediaUnavailable,
	markMediaLoaded,
	resolveMediaLoadError,
};
