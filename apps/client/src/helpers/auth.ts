import { getUrlFromServer } from './get-file-url';
import { clearAuthToken, getRefreshToken, getTokenOrigin, setAuthTokens } from './storage';

type TRefreshResponse = {
	token: string;
	refreshToken: string;
};

// Bound the refresh request so a hung connection cannot pin the in-flight
// promise singleton (refreshAccessTokenPromise) forever and deadlock every
// future caller.
const REFRESH_TIMEOUT_MS = 10_000;

let refreshAccessTokenPromise:
	| {
			origin: string;
			refreshToken: string;
			promise: Promise<boolean>;
	  }
	| undefined;

const refreshAccessTokenOnce = async (): Promise<boolean> => {
	const origin = getTokenOrigin();
	if (!origin) return false;
	const refreshToken = getRefreshToken(origin);

	if (!refreshToken) {
		return false;
	}

	const isSameRefreshToken = (): boolean => getRefreshToken(origin) === refreshToken;

	try {
		const response = await fetch(`${origin}/refresh`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ refreshToken }),
			signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
		});

		if (!response.ok) {
			if ((response.status === 400 || response.status === 401) && isSameRefreshToken()) {
				clearAuthToken(origin);
			}

			return false;
		}

		const data = (await response.json()) as TRefreshResponse;

		if (!data.token || !data.refreshToken) {
			if (isSameRefreshToken()) {
				clearAuthToken(origin);
			}

			return false;
		}

		if (!isSameRefreshToken()) {
			return false;
		}

		setAuthTokens(data.token, data.refreshToken, origin);
		return true;
	} catch (error) {
		// Surface AbortError (timeout) and unexpected network/runtime failures
		// to the console — without this, a timed-out refresh is indistinguishable
		// from a 401 in production diagnostics.
		console.warn('refreshAccessToken failed', error);
		return false;
	}
};

const refreshAccessToken = (): Promise<boolean> => {
	const origin = getTokenOrigin();
	if (!origin) return Promise.resolve(false);
	const refreshToken = getRefreshToken(origin);

	if (!refreshToken) {
		return Promise.resolve(false);
	}

	if (refreshAccessTokenPromise?.origin === origin && refreshAccessTokenPromise.refreshToken === refreshToken) {
		return refreshAccessTokenPromise.promise;
	}

	const promise = refreshAccessTokenOnce().finally(() => {
		if (refreshAccessTokenPromise?.promise === promise) {
			refreshAccessTokenPromise = undefined;
		}
	});

	refreshAccessTokenPromise = { origin, refreshToken, promise };

	return promise;
};

const revokeRefreshToken = async (): Promise<void> => {
	const refreshToken = getRefreshToken();

	if (!refreshToken) {
		return;
	}

	try {
		await fetch(`${getUrlFromServer()}/logout`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ refreshToken }),
		});
	} catch {
		// best effort only - local token clear still logs user out
	}
};

const resetRefreshStateForTests = () => {
	refreshAccessTokenPromise = undefined;
};

export { refreshAccessToken, resetRefreshStateForTests, revokeRefreshToken };
