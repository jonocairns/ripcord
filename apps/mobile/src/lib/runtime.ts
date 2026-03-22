import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {
	configureAppCore,
	connect,
	connectToTRPC,
	fetchServerInfo,
	joinServer,
	loadServerInfo,
	loginWithPassword,
	logoutFromServer,
	useServerStore,
} from '@sharkord/app-core';

const AUTH_TOKEN_KEY = 'sharkord-mobile-auth-token';
const IDENTITY_KEY = 'sharkord-mobile-identity';
const REFRESH_TOKEN_KEY = 'sharkord-mobile-refresh-token';
const SERVER_URL_KEY = 'sharkord-mobile-server-url';

let currentServerUrl = '';
let pendingServerPasswordChallenge:
	| {
			handshakeHash: string;
			serverId: string;
	  }
	| undefined;

const normalizeServerUrl = (serverUrl: string) => {
	const trimmed = serverUrl.trim();

	if (!trimmed) {
		throw new Error('Server URL is required.');
	}

	const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	const url = new URL(withProtocol);

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Only HTTP/HTTPS server URLs are supported.');
	}

	url.pathname = '/';
	url.search = '';
	url.hash = '';

	return url.toString().replace(/\/$/, '');
};

const getServerUrl = () => currentServerUrl;

const setServerUrl = async (serverUrl: string) => {
	currentServerUrl = normalizeServerUrl(serverUrl);
	await AsyncStorage.setItem(SERVER_URL_KEY, currentServerUrl);
};

const getStoredIdentity = async () => {
	return AsyncStorage.getItem(IDENTITY_KEY);
};

const setStoredIdentity = async (identity: string) => {
	await AsyncStorage.setItem(IDENTITY_KEY, identity);
};

const getPendingServerPasswordChallenge = () => pendingServerPasswordChallenge;

const clearPendingServerPasswordChallenge = () => {
	pendingServerPasswordChallenge = undefined;
};

configureAppCore({
	effects: {
		onPasswordRequired: ({ handshakeHash, serverId }) => {
			pendingServerPasswordChallenge = { handshakeHash, serverId };
		},
	},
	serverConfig: {
		getServerHost: () => {
			if (!currentServerUrl) {
				return '';
			}

			return new URL(currentServerUrl).host;
		},
		getServerProtocol: () => {
			if (!currentServerUrl) {
				return 'https:';
			}

			return new URL(currentServerUrl).protocol;
		},
		getServerUrl: () => currentServerUrl,
	},
	storage: {
		clearAuthToken: async () => {
			await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
			await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
		},
		getAuthToken: () => SecureStore.getItemAsync(AUTH_TOKEN_KEY),
		getRefreshToken: () => SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
		setAuthTokens: async (token: string, refreshToken: string) => {
			await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
			await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
		},
	},
});

const bootstrapMobileSession = async () => {
	currentServerUrl = (await AsyncStorage.getItem(SERVER_URL_KEY)) ?? '';

	if (!currentServerUrl) {
		return { status: 'needs-server' as const };
	}

	await loadServerInfo();
	const authToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);

	if (!authToken) {
		return { status: 'needs-login' as const };
	}

	try {
		await connect();
		return { status: 'ready' as const };
	} catch {
		await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
		await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
		return { status: 'needs-login' as const };
	}
};

const loginAndJoinServer = async (payload: {
	identity: string;
	invite?: string;
	password: string;
	serverPassword?: string;
}) => {
	const response = await loginWithPassword(payload);

	await SecureStore.setItemAsync(AUTH_TOKEN_KEY, response.token);
	await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, response.refreshToken);
	await setStoredIdentity(payload.identity);

	const trpc = connectToTRPC(new URL(currentServerUrl).host);
	const { handshakeHash, hasPassword } = await trpc.others.handshake.query();

	if (hasPassword && !payload.serverPassword) {
		pendingServerPasswordChallenge = {
			handshakeHash,
			serverId: useServerStore.getState().info?.serverId ?? 'unknown-server',
		};

		return { kind: 'server-password-required' as const };
	}

	await joinServer(handshakeHash, payload.serverPassword, trpc);
	clearPendingServerPasswordChallenge();

	return { kind: 'joined' as const };
};

const ensureServerInfo = async () => {
	const info = await fetchServerInfo();
	useServerStore.getState().setInfo(info);
	return info;
};

const mobileLogout = async () => {
	clearPendingServerPasswordChallenge();
	await logoutFromServer();
};

export {
	bootstrapMobileSession,
	clearPendingServerPasswordChallenge,
	ensureServerInfo,
	getPendingServerPasswordChallenge,
	getServerUrl,
	getStoredIdentity,
	loginAndJoinServer,
	mobileLogout,
	normalizeServerUrl,
	setServerUrl,
};
