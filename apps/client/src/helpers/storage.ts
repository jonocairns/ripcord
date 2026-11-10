import { getRuntimeServerConfig } from '@/runtime/server-config';
import { getUrlFromServer } from './get-file-url';

export enum LocalStorageKey {
	AUTH_TOKEN = 'sharkord-auth-token',
	REFRESH_TOKEN = 'sharkord-refresh-token',
	IDENTITY = 'sharkord-identity',
	VITE_UI_THEME = 'vite-ui-theme',
	DEVICES_SETTINGS = 'sharkord-devices-settings',
	FLOATING_CARD_POSITION = 'sharkord-floating-card-position',
	LEFT_SIDEBAR_WIDTH = 'sharkord-left-sidebar-width',
	RIGHT_SIDEBAR_STATE = 'sharkord-right-sidebar-state',
	RIGHT_SIDEBAR_COLLAPSED = 'sharkord-right-sidebar-collapsed',
	VOICE_CHAT_SIDEBAR_STATE = 'sharkord-voice-chat-sidebar-state',
	VOICE_CHAT_SIDEBAR_WIDTH = 'sharkord-voice-chat-sidebar-width',
	VOLUME_SETTINGS = 'sharkord-volume-settings',
	RECENT_EMOJIS = 'sharkord-recent-emojis',
}

export enum SessionStorageKey {
	TOKEN = 'sharkord-token',
}

/** One-time migration: purge passwords stored by older client builds.
 *  Safe to remove once all clients have been updated past this version. */
const migrateStorage = () => {
	localStorage.removeItem('sharkord-user-password');
	localStorage.removeItem('sharkord-server-password');
};

const getLocalStorageItem = (key: LocalStorageKey): string | null => {
	return localStorage.getItem(key);
};

const getLocalStorageItemAsJSON = <T>(key: LocalStorageKey, defaultValue: T | undefined = undefined): T | undefined => {
	const item = localStorage.getItem(key);

	if (item) {
		try {
			return JSON.parse(item) as T;
		} catch {
			// Corrupt/legacy stored value — fall back to the default rather than
			// letting the parse throw propagate to callers (several read at startup).
			console.warn('[storage] Failed to parse localStorage key:', key, '- falling back to default.');
			return defaultValue;
		}
	}

	return defaultValue;
};

const setLocalStorageItemAsJSON = <T>(key: LocalStorageKey, value: T): void => {
	localStorage.setItem(key, JSON.stringify(value));
};

const setLocalStorageItem = (key: LocalStorageKey, value: string): void => {
	localStorage.setItem(key, value);
};

const getTokenOrigin = (): string | undefined => {
	if (!getRuntimeServerConfig().isConfigured) return undefined;
	return new URL(getUrlFromServer()).origin;
};

const tokenEntries = () => [
	{ storage: localStorage, key: LocalStorageKey.AUTH_TOKEN },
	{ storage: localStorage, key: LocalStorageKey.REFRESH_TOKEN },
	{ storage: sessionStorage, key: SessionStorageKey.TOKEN },
];

// Pre-per-origin tokens carry no record of which server issued them, so they
// are adopted by whichever server is configured at first launch after the
// update. That is the server the previous client was already sending them to.
const migrateAuthTokens = () => {
	const origin = getTokenOrigin();
	for (const { storage, key } of tokenEntries()) {
		const legacy = storage.getItem(key);
		if (origin && legacy !== null && storage.getItem(`${key}:${origin}`) === null) {
			storage.setItem(`${key}:${origin}`, legacy);
		}
		storage.removeItem(key);
	}
};

// Only the automatic secure upgrade may move credentials between origins.
const upgradeAuthTokenOrigin = (fromOrigin: string, toOrigin: string) => {
	const from = new URL(fromOrigin);
	const to = new URL(toOrigin);
	if (from.protocol !== 'http:' || to.protocol !== 'https:' || from.host !== to.host) return;
	for (const { storage, key } of tokenEntries()) {
		const sourceKey = `${key}:${from.origin}`;
		const targetKey = `${key}:${to.origin}`;
		const token = storage.getItem(sourceKey);
		if (token !== null && storage.getItem(targetKey) === null) {
			storage.setItem(targetKey, token);
		}
		storage.removeItem(sourceKey);
	}
};

const getAuthToken = (origin = getTokenOrigin()): string | null => {
	if (!origin || !getRuntimeServerConfig().isConfigured) return null;
	return (
		sessionStorage.getItem(`${SessionStorageKey.TOKEN}:${origin}`) ||
		localStorage.getItem(`${LocalStorageKey.AUTH_TOKEN}:${origin}`)
	);
};

const hydrateSessionToken = (origin = getTokenOrigin()): string | null => {
	const token = getAuthToken(origin);
	if (origin && token) sessionStorage.setItem(`${SessionStorageKey.TOKEN}:${origin}`, token);
	return token;
};

const setAuthToken = (token: string, origin = getTokenOrigin()): void => {
	if (!origin || !getRuntimeServerConfig().isConfigured) return;
	sessionStorage.setItem(`${SessionStorageKey.TOKEN}:${origin}`, token);
	localStorage.setItem(`${LocalStorageKey.AUTH_TOKEN}:${origin}`, token);
};

const getRefreshToken = (origin = getTokenOrigin()): string | null => {
	if (!origin || !getRuntimeServerConfig().isConfigured) return null;
	return localStorage.getItem(`${LocalStorageKey.REFRESH_TOKEN}:${origin}`);
};

const setRefreshToken = (refreshToken: string, origin = getTokenOrigin()): void => {
	if (!origin || !getRuntimeServerConfig().isConfigured) return;
	localStorage.setItem(`${LocalStorageKey.REFRESH_TOKEN}:${origin}`, refreshToken);
};

const setAuthTokens = (token: string, refreshToken: string, origin = getTokenOrigin()): void => {
	setAuthToken(token, origin);
	setRefreshToken(refreshToken, origin);
};

const clearAuthToken = (origin = getTokenOrigin()): void => {
	if (!origin || !getRuntimeServerConfig().isConfigured) return;
	for (const { storage, key } of tokenEntries()) storage.removeItem(`${key}:${origin}`);
};

export {
	clearAuthToken,
	getAuthToken,
	getLocalStorageItem,
	getLocalStorageItemAsJSON,
	getRefreshToken,
	getTokenOrigin,
	hydrateSessionToken,
	migrateAuthTokens,
	migrateStorage,
	setAuthToken,
	setAuthTokens,
	setLocalStorageItem,
	setLocalStorageItemAsJSON,
	setRefreshToken,
	upgradeAuthTokenOrigin,
};
