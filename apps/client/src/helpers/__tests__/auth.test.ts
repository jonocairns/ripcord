import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

const SERVER_URL = 'http://example.test';

const createMemoryStorage = () => {
	const store = new Map<string, string>();
	return {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		clear: () => {
			store.clear();
		},
		get length() {
			return store.size;
		},
		key: (index: number) => Array.from(store.keys())[index] ?? null,
	} satisfies Storage;
};

const installStorageStubs = () => {
	Reflect.set(globalThis, 'localStorage', createMemoryStorage());
	Reflect.set(globalThis, 'sessionStorage', createMemoryStorage());
};

const seedTokens = (accessToken: string, refreshToken: string) => {
	localStorage.setItem(`sharkord-auth-token:${SERVER_URL}`, accessToken);
	localStorage.setItem(`sharkord-refresh-token:${SERVER_URL}`, refreshToken);
	sessionStorage.setItem(`sharkord-token:${SERVER_URL}`, accessToken);
};

const readStoredTokens = () => ({
	access:
		localStorage.getItem(`sharkord-auth-token:${SERVER_URL}`) ?? sessionStorage.getItem(`sharkord-token:${SERVER_URL}`),
	refresh: localStorage.getItem(`sharkord-refresh-token:${SERVER_URL}`),
});

const serverConfig = await import('@/runtime/server-config');
let restoreRuntimeConfig: (() => void) | undefined;

let originalFetch: typeof fetch | undefined;

describe('refreshAccessToken — rotation race', () => {
	beforeEach(() => {
		installStorageStubs();
		const configSpy = spyOn(serverConfig, 'getRuntimeServerConfig').mockReturnValue({
			source: 'web',
			serverUrl: SERVER_URL,
			serverHost: 'example.test',
			isConfigured: true,
			needsSetup: false,
		});
		restoreRuntimeConfig = () => configSpy.mockRestore();
		originalFetch = globalThis.fetch;
	});

	afterEach(async () => {
		restoreRuntimeConfig?.();
		restoreRuntimeConfig = undefined;
		if (originalFetch) {
			Reflect.set(globalThis, 'fetch', originalFetch);
		}
		const { resetRefreshStateForTests } = await import('../auth');
		resetRefreshStateForTests();
	});

	test('a single refresh rotates tokens cleanly', async () => {
		seedTokens('access-old', 'refresh-old');

		const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
			return new Response(JSON.stringify({ success: true, token: 'access-new', refreshToken: 'refresh-new' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		Reflect.set(globalThis, 'fetch', fetchMock);

		const { refreshAccessToken } = await import('../auth');

		const ok = await refreshAccessToken();

		expect(ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(readStoredTokens()).toEqual({ access: 'access-new', refresh: 'refresh-new' });
	});

	test('two concurrent refreshes share one rotating request', async () => {
		seedTokens('access-old', 'refresh-old');

		// Simulate the real server: the first request to arrive rotates the token
		// and returns 200; any subsequent request bearing the same (now-revoked)
		// refresh token returns 401. This mirrors apps/server/src/http/refresh.ts.
		let calls = 0;
		const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
			calls += 1;

			if (calls === 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));

				return new Response(JSON.stringify({ success: true, token: 'access-new', refreshToken: 'refresh-new' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			await new Promise((resolve) => setTimeout(resolve, 10));

			return new Response(JSON.stringify({ error: 'Invalid refresh token' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		Reflect.set(globalThis, 'fetch', fetchMock);

		const { refreshAccessToken } = await import('../auth');

		const results = await Promise.all([refreshAccessToken(), refreshAccessToken()]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(results).toEqual([true, true]);
		expect(readStoredTokens()).toEqual({ access: 'access-new', refresh: 'refresh-new' });
	});

	test('arbitrary fan-in: many concurrent refreshes still share one request', async () => {
		seedTokens('access-old', 'refresh-old');

		const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
			await new Promise((resolve) => setTimeout(resolve, 10));

			return new Response(JSON.stringify({ success: true, token: 'access-new', refreshToken: 'refresh-new' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		Reflect.set(globalThis, 'fetch', fetchMock);

		const { refreshAccessToken } = await import('../auth');

		const results = await Promise.all(Array.from({ length: 5 }, () => refreshAccessToken()));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(results).toEqual([true, true, true, true, true]);
		expect(readStoredTokens()).toEqual({ access: 'access-new', refresh: 'refresh-new' });
	});

	test('a hung refresh times out and does NOT sign the user out', async () => {
		seedTokens('access-old', 'refresh-old');

		// Simulate a hung server: fetch never resolves on its own, only the
		// AbortSignal.timeout passed by refreshAccessTokenOnce can unblock it.
		// Without the timeout, the in-flight promise singleton would be pinned
		// forever and every future refresh attempt would deadlock.
		const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;

				if (!signal) {
					return;
				}

				signal.addEventListener('abort', () => {
					reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
				});
			});
		});
		Reflect.set(globalThis, 'fetch', fetchMock);

		const originalTimeout = AbortSignal.timeout;
		AbortSignal.timeout = (_ms: number) => originalTimeout.call(AbortSignal, 20);

		try {
			const { refreshAccessToken } = await import('../auth');

			const result = await refreshAccessToken();

			expect(result).toBe(false);
			// Auth tokens must be preserved on timeout: the user might still
			// have a valid session, the network is just unreachable.
			expect(readStoredTokens()).toEqual({ access: 'access-old', refresh: 'refresh-old' });

			// The singleton must be cleared so the next attempt can re-fetch
			// rather than reusing the rejected promise.
			const followUpFetch = mock(async () => {
				return new Response(JSON.stringify({ success: true, token: 'access-new', refreshToken: 'refresh-new' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			});
			Reflect.set(globalThis, 'fetch', followUpFetch);

			const followUp = await refreshAccessToken();

			expect(followUp).toBe(true);
			expect(followUpFetch).toHaveBeenCalledTimes(1);
		} finally {
			AbortSignal.timeout = originalTimeout;
		}
	});

	test('a late successful refresh cannot overwrite newer auth tokens', async () => {
		seedTokens('access-old', 'refresh-old');

		let resolveRefresh: ((response: Response) => void) | undefined;
		const fetchMock = mock((_input: RequestInfo | URL, _init?: RequestInit) => {
			return new Promise<Response>((resolve) => {
				resolveRefresh = resolve;
			});
		});
		Reflect.set(globalThis, 'fetch', fetchMock);

		const { refreshAccessToken } = await import('../auth');

		const refreshPromise = refreshAccessToken();

		seedTokens('access-newer', 'refresh-newer');
		resolveRefresh?.(
			new Response(JSON.stringify({ success: true, token: 'access-stale', refreshToken: 'refresh-stale' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const result = await refreshPromise;

		expect(result).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(readStoredTokens()).toEqual({ access: 'access-newer', refresh: 'refresh-newer' });
	});

	test('a refresh after token rotation does not share a stale in-flight request', async () => {
		seedTokens('access-old', 'refresh-old');

		let resolveOldRefresh: ((response: Response) => void) | undefined;
		const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => {
			const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};

			if (body.refreshToken === 'refresh-old') {
				return new Promise<Response>((resolve) => {
					resolveOldRefresh = resolve;
				});
			}

			return Promise.resolve(
				new Response(JSON.stringify({ success: true, token: 'access-latest', refreshToken: 'refresh-latest' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			);
		});
		Reflect.set(globalThis, 'fetch', fetchMock);

		const { refreshAccessToken } = await import('../auth');

		const oldRefreshPromise = refreshAccessToken();

		seedTokens('access-newer', 'refresh-newer');
		const newerRefreshResult = await refreshAccessToken();

		resolveOldRefresh?.(
			new Response(JSON.stringify({ success: true, token: 'access-stale', refreshToken: 'refresh-stale' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		const oldRefreshResult = await oldRefreshPromise;

		expect(newerRefreshResult).toBe(true);
		expect(oldRefreshResult).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([`${SERVER_URL}/refresh`, `${SERVER_URL}/refresh`]);
		expect(readStoredTokens()).toEqual({ access: 'access-latest', refresh: 'refresh-latest' });
	});

	test('a late failed refresh cannot clear newer auth tokens', async () => {
		seedTokens('access-old', 'refresh-old');

		let resolveRefresh: ((response: Response) => void) | undefined;
		const fetchMock = mock((_input: RequestInfo | URL, _init?: RequestInit) => {
			return new Promise<Response>((resolve) => {
				resolveRefresh = resolve;
			});
		});
		Reflect.set(globalThis, 'fetch', fetchMock);

		const { refreshAccessToken } = await import('../auth');

		const refreshPromise = refreshAccessToken();

		seedTokens('access-newer', 'refresh-newer');
		resolveRefresh?.(
			new Response(JSON.stringify({ error: 'Invalid refresh token' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const result = await refreshPromise;

		expect(result).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(readStoredTokens()).toEqual({ access: 'access-newer', refresh: 'refresh-newer' });
	});
	test('a refresh stays pinned to A after switching to B', async () => {
		seedTokens('access-a', 'refresh-a');
		let resolveRefresh: ((response: Response) => void) | undefined;
		const fetchMock = mock(
			(_input: RequestInfo | URL, _init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					resolveRefresh = resolve;
				}),
		);
		Reflect.set(globalThis, 'fetch', fetchMock);
		const { refreshAccessToken } = await import('../auth');
		const pending = refreshAccessToken();
		spyOn(serverConfig, 'getRuntimeServerConfig').mockReturnValue({
			source: 'desktop',
			serverUrl: 'https://b.test',
			serverHost: 'b.test',
			isConfigured: true,
			needsSetup: false,
		});
		expect(await refreshAccessToken()).toBe(false);
		resolveRefresh?.(Response.json({ token: 'rotated-a', refreshToken: 'rotated-refresh-a' }));
		expect(await pending).toBe(true);
		expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([`${SERVER_URL}/refresh`]);
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ refreshToken: 'refresh-a' }));
		const { getAuthToken, getRefreshToken } = await import('../storage');
		expect(getAuthToken()).toBeNull();
		expect(getRefreshToken()).toBeNull();
		expect(readStoredTokens()).toEqual({ access: 'rotated-a', refresh: 'rotated-refresh-a' });
	});

	test('equal refresh token strings on different origins do not share requests', async () => {
		seedTokens('access-a', 'same-refresh');
		let resolveA: ((response: Response) => void) | undefined;
		const fetchMock = mock((input: RequestInfo | URL, _init?: RequestInit) => {
			if (input === `${SERVER_URL}/refresh`)
				return new Promise<Response>((resolve) => {
					resolveA = resolve;
				});
			return Promise.resolve(Response.json({ token: 'new-b', refreshToken: 'new-refresh-b' }));
		});
		Reflect.set(globalThis, 'fetch', fetchMock);
		const { refreshAccessToken } = await import('../auth');
		const pendingA = refreshAccessToken();
		spyOn(serverConfig, 'getRuntimeServerConfig').mockReturnValue({
			source: 'desktop',
			serverUrl: 'https://b.test',
			serverHost: 'b.test',
			isConfigured: true,
			needsSetup: false,
		});
		const { setAuthTokens, getAuthToken } = await import('../storage');
		setAuthTokens('access-b', 'same-refresh');
		expect(await refreshAccessToken()).toBe(true);
		resolveA?.(new Response(null, { status: 401 }));
		expect(await pendingA).toBe(false);
		expect(getAuthToken()).toBe('new-b');
		expect(readStoredTokens()).toEqual({ access: null, refresh: null });
		expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([`${SERVER_URL}/refresh`, 'https://b.test/refresh']);
	});
});
