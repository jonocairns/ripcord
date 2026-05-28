import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

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
	(globalThis as { localStorage: Storage }).localStorage.setItem('sharkord-auth-token', accessToken);
	(globalThis as { localStorage: Storage }).localStorage.setItem('sharkord-refresh-token', refreshToken);
	(globalThis as { sessionStorage: Storage }).sessionStorage.setItem('sharkord-token', accessToken);
};

const readStoredTokens = () => ({
	access:
		(globalThis as { localStorage: Storage }).localStorage.getItem('sharkord-auth-token') ??
		(globalThis as { sessionStorage: Storage }).sessionStorage.getItem('sharkord-token'),
	refresh: (globalThis as { localStorage: Storage }).localStorage.getItem('sharkord-refresh-token'),
});

mock.module('@/runtime/server-config', () => ({
	getRuntimeServerConfig: () => ({
		source: 'web',
		serverUrl: SERVER_URL,
		serverHost: 'example.test',
	}),
}));

let originalFetch: typeof fetch | undefined;

describe('refreshAccessToken — rotation race', () => {
	beforeEach(() => {
		installStorageStubs();
		originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
	});

	afterEach(() => {
		if (originalFetch) {
			Reflect.set(globalThis, 'fetch', originalFetch);
		}
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
		AbortSignal.timeout = ((_ms: number) => originalTimeout.call(AbortSignal, 20)) as typeof AbortSignal.timeout;

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
			const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { refreshToken?: string }) : {};

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
});
