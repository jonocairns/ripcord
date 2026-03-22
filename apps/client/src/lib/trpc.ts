import {
	cleanup,
	configureAppCore,
	connectToTRPC,
	getTRPCClient,
	reconnectTRPC,
	setOnWsReconnect,
	type AppRouter,
} from '@sharkord/app-core';
import { resetApp } from '@/features/app/actions';
import { resetDialogs } from '@/features/dialogs/actions';
import { resetServerState } from '@/features/server/actions';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { resetServerScreens } from '@/features/server-screens/actions';
import { clearAuthToken, getAuthToken, getRefreshToken, setAuthTokens } from '@/helpers/storage';
import { getRuntimeServerConfig } from '@/runtime/server-config';

configureAppCore({
	effects: {
		onReset: () => {
			resetServerScreens();
			resetServerState();
			resetDialogs();
			resetApp();
		},
		onServerDisconnected: () => {
			playSound(SoundType.SERVER_DISCONNECTED);
		},
	},
	serverConfig: {
		getServerHost: () => {
			const runtimeConfig = getRuntimeServerConfig();

			if (runtimeConfig.serverHost) {
				return runtimeConfig.serverHost;
			}

			return import.meta.env.MODE === 'development' ? 'localhost:4991' : window.location.host;
		},
		getServerProtocol: () => {
			const runtimeConfig = getRuntimeServerConfig();

			if (runtimeConfig.serverUrl) {
				return new URL(runtimeConfig.serverUrl).protocol;
			}

			return window.location.protocol;
		},
		getServerUrl: () => {
			const runtimeConfig = getRuntimeServerConfig();

			if (runtimeConfig.serverUrl) {
				return runtimeConfig.serverUrl;
			}

			if (import.meta.env.MODE === 'development') {
				return 'http://localhost:4991';
			}

			return `${window.location.protocol}//${window.location.host}`;
		},
	},
	storage: {
		clearAuthToken,
		getAuthToken,
		getRefreshToken,
		setAuthTokens,
	},
});

export { cleanup, connectToTRPC, getTRPCClient, reconnectTRPC, setOnWsReconnect };
export type { AppRouter };
