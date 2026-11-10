import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as serverConfig from '@/runtime/server-config';
import {
	clearAuthToken,
	getAuthToken,
	getRefreshToken,
	hydrateSessionToken,
	migrateAuthTokens,
	setAuthTokens,
	upgradeAuthTokenOrigin,
} from '../storage';

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

const A = 'http://a.example';
const B = 'https://b.example';
const configure = (origin: string, isConfigured = true) =>
	spyOn(serverConfig, 'getRuntimeServerConfig').mockReturnValue({
		source: 'desktop',
		serverUrl: origin,
		serverHost: origin ? new URL(origin).host : '',
		isConfigured,
		needsSetup: !isConfigured,
	});
const entries = () => [
	{ storage: localStorage, key: 'sharkord-auth-token', value: 'access' },
	{ storage: localStorage, key: 'sharkord-refresh-token', value: 'refresh' },
	{ storage: sessionStorage, key: 'sharkord-token', value: 'session' },
];

describe('per-origin tokens', () => {
	beforeEach(() => {
		installStorageStubs();
		configure(A);
	});
	afterEach(() => {
		mock.restore();
	});

	test('switching A to B to A preserves separate sessions, including session hydration and logout', () => {
		setAuthTokens('access-a', 'refresh-a');
		configure(B);
		expect(getAuthToken()).toBeNull();
		expect(getRefreshToken()).toBeNull();
		setAuthTokens('access-b', 'refresh-b');
		configure(A);
		expect(getAuthToken()).toBe('access-a');
		expect(getRefreshToken()).toBe('refresh-a');
		sessionStorage.clear();
		expect(hydrateSessionToken()).toBe('access-a');
		expect(sessionStorage.getItem(`sharkord-token:${A}`)).toBe('access-a');
		clearAuthToken();
		expect(getAuthToken()).toBeNull();
		expect(getRefreshToken()).toBeNull();
		expect(getAuthToken(B)).toBe('access-b');
		expect(getRefreshToken(B)).toBe('refresh-b');
	});

	test('legacy entries migrate once to the current origin', () => {
		for (const { storage, key, value } of entries()) storage.setItem(key, value);
		migrateAuthTokens();
		migrateAuthTokens();
		for (const { storage, key, value } of entries()) {
			expect(storage.getItem(key)).toBeNull();
			expect(storage.getItem(`${key}:${A}`)).toBe(value);
		}
		expect(getAuthToken()).toBe('session');
	});

	test('legacy entries never overwrite existing scoped entries', () => {
		for (const { storage, key, value } of entries()) {
			storage.setItem(key, 'legacy');
			storage.setItem(`${key}:${A}`, value);
		}
		migrateAuthTokens();
		for (const { storage, key, value } of entries()) {
			expect(storage.getItem(key)).toBeNull();
			expect(storage.getItem(`${key}:${A}`)).toBe(value);
		}
	});

	test('unconfigured desktop discards legacy credentials and cannot read or write tokens', () => {
		for (const { storage, key, value } of entries()) storage.setItem(key, value);
		configure('', false);
		migrateAuthTokens();
		setAuthTokens('ignored', 'ignored');
		setAuthTokens('ignored', 'ignored', A);
		expect(getAuthToken()).toBeNull();
		expect(getRefreshToken()).toBeNull();
		expect(hydrateSessionToken()).toBeNull();
		expect(localStorage.length).toBe(0);
		expect(sessionStorage.length).toBe(0);
	});

	test('secure upgrade cannot downgrade or transfer to a different host', () => {
		setAuthTokens('access-a', 'refresh-a');
		upgradeAuthTokenOrigin(A, B);
		expect(getAuthToken(A)).toBe('access-a');
		upgradeAuthTokenOrigin(A, 'https://a.example');
		expect(getAuthToken(A)).toBeNull();
		upgradeAuthTokenOrigin('https://a.example', A);
		expect(getAuthToken('https://a.example')).toBe('access-a');
		expect(getAuthToken(A)).toBeNull();
	});

	test('initialization moves HTTP credentials to HTTPS before legacy migration', async () => {
		mock.restore();
		const originalWindow = globalThis.window;
		const originalFetch = globalThis.fetch;
		const setServerUrl = mock(async (_url: string) => {});
		Reflect.set(globalThis, 'window', { sharkordDesktop: { getServerUrl: async () => A, setServerUrl } });
		Reflect.set(
			globalThis,
			'fetch',
			mock(async () => new Response()),
		);
		try {
			for (const { storage, key, value } of entries()) {
				storage.setItem(`${key}:${A}`, value);
				storage.setItem(key, 'older-legacy');
			}
			const config = await serverConfig.initializeRuntimeServerConfig();
			expect(config.serverUrl).toBe('https://a.example');
			const upgrade = serverConfig.consumeServerOriginUpgrade();
			expect(upgrade).toEqual({ fromOrigin: A, toOrigin: 'https://a.example' });
			expect(serverConfig.consumeServerOriginUpgrade()).toBeUndefined();
			if (upgrade) upgradeAuthTokenOrigin(upgrade.fromOrigin, upgrade.toOrigin);
			migrateAuthTokens();
			for (const { storage, key, value } of entries()) {
				expect(storage.getItem(`${key}:${A}`)).toBeNull();
				expect(storage.getItem(`${key}:https://a.example`)).toBe(value);
				expect(storage.getItem(key)).toBeNull();
			}
			expect(setServerUrl).toHaveBeenCalledWith('https://a.example');
		} finally {
			Reflect.set(globalThis, 'window', originalWindow);
			Reflect.set(globalThis, 'fetch', originalFetch);
		}
	});
});

describe('saving a desktop server URL', () => {
	let originalWindow: typeof globalThis.window;
	let originalFetch: typeof globalThis.fetch;
	const setServerUrl = mock(async (_url: string) => {});

	beforeEach(() => {
		installStorageStubs();
		originalWindow = globalThis.window;
		originalFetch = globalThis.fetch;
		setServerUrl.mockReset();
		setServerUrl.mockImplementation(async (_url: string) => {});
		Reflect.set(globalThis, 'window', { sharkordDesktop: { setServerUrl } });
		Reflect.set(
			globalThis,
			'fetch',
			mock(async () => new Response()),
		);
	});

	afterEach(() => {
		Reflect.set(globalThis, 'window', originalWindow);
		Reflect.set(globalThis, 'fetch', originalFetch);
		mock.restore();
	});

	test.each([
		['same host', A, A, 'https://a.example', true],
		['same host and explicit port', 'http://a.example:4991', 'http://a.example:4991', 'https://a.example:4991', true],
		['different host', A, 'http://b.example', B, false],
		['different port', 'http://a.example:4991', 'http://a.example:4992', 'https://a.example:4992', false],
		['changed default port', 'http://a.example:443', 'http://a.example:443', 'https://a.example', false],
		['already HTTPS', 'https://a.example', 'https://a.example', 'https://a.example', false],
		['private HTTP without upgrade', 'http://localhost:4991', 'http://localhost:4991', 'http://localhost:4991', false],
		['HTTPS to private HTTP', 'https://localhost:4991', 'http://localhost:4991', 'http://localhost:4991', false],
	])('%s preserves credentials only for an automatic same-host/port upgrade', async (_label, source, input, saved, moves) => {
		for (const { storage, key, value } of entries()) storage.setItem(`${key}:${source}`, value);
		await serverConfig.updateDesktopServerUrl(input, upgradeAuthTokenOrigin);
		expect(setServerUrl).toHaveBeenCalledWith(saved);
		for (const { storage, key, value } of entries()) {
			expect(storage.getItem(`${key}:${source}`)).toBe(moves ? null : value);
			if (source !== saved) expect(storage.getItem(`${key}:${saved}`)).toBe(moves ? value : null);
		}
	});

	test('failed HTTPS probe leaves HTTP credentials in place', async () => {
		Reflect.set(
			globalThis,
			'fetch',
			mock(async () => {
				throw new Error('TLS unavailable');
			}),
		);
		for (const { storage, key, value } of entries()) storage.setItem(`${key}:${A}`, value);
		await serverConfig.updateDesktopServerUrl(A, upgradeAuthTokenOrigin);
		expect(setServerUrl).toHaveBeenCalledWith(A);
		for (const { storage, key, value } of entries()) {
			expect(storage.getItem(`${key}:${A}`)).toBe(value);
			expect(storage.getItem(`${key}:https://a.example`)).toBeNull();
		}
	});

	test('failed save does not move credentials', async () => {
		setServerUrl.mockRejectedValueOnce(new Error('Save failed'));
		for (const { storage, key, value } of entries()) storage.setItem(`${key}:${A}`, value);
		await expect(serverConfig.updateDesktopServerUrl(A, upgradeAuthTokenOrigin)).rejects.toThrow('Save failed');
		for (const { storage, key, value } of entries()) {
			expect(storage.getItem(`${key}:${A}`)).toBe(value);
			expect(storage.getItem(`${key}:https://a.example`)).toBeNull();
		}
	});

	test('automatic upgrade preserves existing HTTPS credentials', async () => {
		for (const { storage, key, value } of entries()) {
			storage.setItem(`${key}:${A}`, value);
			storage.setItem(`${key}:https://a.example`, 'existing');
		}
		await serverConfig.updateDesktopServerUrl(A, upgradeAuthTokenOrigin);
		for (const { storage, key } of entries()) {
			expect(storage.getItem(`${key}:${A}`)).toBeNull();
			expect(storage.getItem(`${key}:https://a.example`)).toBe('existing');
		}
	});
});
