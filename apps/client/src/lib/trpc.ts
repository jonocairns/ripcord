import type { AppRouter, TConnectionParams } from '@sharkord/shared';
import { DisconnectCode } from '@sharkord/shared';
import { createTRPCProxyClient, createWSClient, wsLink } from '@trpc/client';
import { resetApp } from '@/features/app/actions';
import { resetDialogs } from '@/features/dialogs/actions';
import { resetServerState, setDisconnectInfo } from '@/features/server/actions';
import { useServerStore } from '@/features/server/slice';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import {
	captureVoiceReconnectIntentForCurrentSession,
	clearVoiceReconnectRecovery,
	ensureVoiceReconnectStarted,
} from '@/features/server/voice/reconnect-coordinator';
import { isVoiceReconnectOnline } from '@/features/server/voice/reconnect-lab-debug';
import { resetServerScreens } from '@/features/server-screens/actions';
import { clearAuthToken, getAuthToken } from '@/helpers/storage';
import { getRuntimeServerConfig } from '@/runtime/server-config';
import { markSocketCloseEventIgnored, shouldIgnoreSocketCloseEvent } from './websocket-close-ignore';
import { getWsReconnectOpenAction, shouldResumeDeferredWsReconnect } from './ws-reconnect-gate';

let wsClient: ReturnType<typeof createWSClient> | null = null;
let trpc: ReturnType<typeof createTRPCProxyClient<AppRouter>> | null = null;
let currentHost: string | null = null;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
let onWsReconnect: (() => void) | null = null;
let cachedClientInstanceId: string | null = null;
let deferredWsReconnectOnlineListener: (() => void) | null = null;

// How long to wait for tRPC to reconnect before tearing down the app state.
const RETRY_GRACE_PERIOD_MS = 5000;
const WS_CLIENT_INSTANCE_ID_STORAGE_KEY = 'ripcord.ws-client-instance-id';

// These codes represent deliberate server-side actions — retrying immediately is
// pointless (KICKED/BANNED) or premature (SERVER_SHUTDOWN). All other codes
// (e.g. 1006 UNEXPECTED) get silent tRPC-level retries before app teardown.
const DELIBERATE_DISCONNECT_CODES = new Set<number>([
	DisconnectCode.KICKED,
	DisconnectCode.BANNED,
	DisconnectCode.SERVER_SHUTDOWN,
]);

const createClientInstanceId = () => {
	const randomUUID = globalThis.crypto?.randomUUID;

	if (typeof randomUUID === 'function') {
		return randomUUID.call(globalThis.crypto);
	}

	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const getWsClientInstanceId = () => {
	if (cachedClientInstanceId) {
		return cachedClientInstanceId;
	}

	if (typeof window !== 'undefined') {
		try {
			const storedClientInstanceId = window.sessionStorage.getItem(WS_CLIENT_INSTANCE_ID_STORAGE_KEY);

			if (storedClientInstanceId) {
				cachedClientInstanceId = storedClientInstanceId;
				return storedClientInstanceId;
			}

			const nextClientInstanceId = createClientInstanceId();
			window.sessionStorage.setItem(WS_CLIENT_INSTANCE_ID_STORAGE_KEY, nextClientInstanceId);
			cachedClientInstanceId = nextClientInstanceId;
			return nextClientInstanceId;
		} catch {
			// Fall back to an in-memory identifier when sessionStorage is unavailable.
		}
	}

	cachedClientInstanceId = createClientInstanceId();
	return cachedClientInstanceId;
};

const clearDeferredWsReconnectOnlineListener = () => {
	if (!deferredWsReconnectOnlineListener || typeof window === 'undefined') {
		deferredWsReconnectOnlineListener = null;
		return;
	}

	window.removeEventListener('online', deferredWsReconnectOnlineListener);
	deferredWsReconnectOnlineListener = null;
};

const initializeTRPC = (host: string) => {
	const runtimeServerUrl = getRuntimeServerConfig().serverUrl;
	const serverProtocol = runtimeServerUrl ? new URL(runtimeServerUrl).protocol : window.location.protocol;
	const protocol = serverProtocol === 'https:' ? 'wss' : 'ws';

	wsClient = createWSClient({
		url: `${protocol}://${host}`,
		// @ts-expect-error - the onclose type is not correct in trpc
		onClose: (cause: CloseEvent) => {
			if (shouldIgnoreSocketCloseEvent(cause)) {
				return;
			}

			clearDeferredWsReconnectOnlineListener();

			const state = useServerStore.getState();
			const wasConnected = state.connected;

			if (DELIBERATE_DISCONNECT_CODES.has(cause.code)) {
				// Tear down immediately for intentional server-side disconnects
				if (cause.code === DisconnectCode.KICKED) {
					clearVoiceReconnectRecovery('kicked');
				} else if (cause.code === DisconnectCode.BANNED) {
					clearVoiceReconnectRecovery('banned');
				}
				cleanup({ skipSocketClose: true });
				if (wasConnected) {
					playSound(SoundType.SERVER_DISCONNECTED);
				}
				setDisconnectInfo({
					code: cause.code,
					reason: cause.reason,
					wasClean: cause.wasClean,
					time: new Date(),
				});
				return;
			}

			if (captureVoiceReconnectIntentForCurrentSession()) {
				ensureVoiceReconnectStarted();
			}

			// Give tRPC's internal retry a grace period before tearing down.
			// If tRPC reconnects (onOpen fires), the teardown is cancelled.
			if (teardownTimer) {
				clearTimeout(teardownTimer);
			}
			teardownTimer = setTimeout(() => {
				teardownTimer = null;
				cleanup({ skipSocketClose: true });
				if (wasConnected) {
					playSound(SoundType.SERVER_DISCONNECTED);
				}
				setDisconnectInfo({
					code: cause.code,
					reason: cause.reason,
					wasClean: cause.wasClean,
					time: new Date(),
				});
			}, RETRY_GRACE_PERIOD_MS);
		},
		onOpen: () => {
			const resumeReconnect = () => {
				const pendingTeardownTimer = teardownTimer;

				if (
					!shouldResumeDeferredWsReconnect({
						hasTeardownTimer: pendingTeardownTimer !== null,
						isSocketOpen: wsClient?.connection?.ws?.readyState === WebSocket.OPEN,
					})
				) {
					return;
				}

				if (pendingTeardownTimer) {
					clearTimeout(pendingTeardownTimer);
				}
				teardownTimer = null;

				// The WS reconnected after a disconnect. The new server-side context
				// is unauthenticated (authenticated: false in createContext), so we
				// need to re-run handshake → joinServer to restore auth, subscriptions,
				// and voice state.
				onWsReconnect?.();
			};

			switch (
				getWsReconnectOpenAction({
					hasTeardownTimer: teardownTimer !== null,
					isReconnectOnline: isVoiceReconnectOnline(),
				})
			) {
				case 'ignore':
					return;
				case 'defer': {
					clearDeferredWsReconnectOnlineListener();

					if (typeof window === 'undefined') {
						return;
					}

					deferredWsReconnectOnlineListener = () => {
						clearDeferredWsReconnectOnlineListener();
						resumeReconnect();
					};

					window.addEventListener('online', deferredWsReconnectOnlineListener, { once: true });
					return;
				}
				case 'resume':
					clearDeferredWsReconnectOnlineListener();
					resumeReconnect();
					return;
			}
		},
		connectionParams: async (): Promise<TConnectionParams> => {
			return {
				token: getAuthToken() || '',
				clientInstanceId: getWsClientInstanceId(),
			};
		},
	});

	trpc = createTRPCProxyClient<AppRouter>({
		links: [wsLink({ client: wsClient })],
	});

	currentHost = host;

	return trpc;
};

const connectToTRPC = (host: string) => {
	if (trpc && currentHost === host) {
		return trpc;
	}

	return initializeTRPC(host);
};

const reconnectTRPC = (host: string) => {
	clearDeferredWsReconnectOnlineListener();

	if (teardownTimer) {
		clearTimeout(teardownTimer);
		teardownTimer = null;
	}

	if (wsClient) {
		markSocketCloseEventIgnored(wsClient.connection?.ws);
		wsClient.close();
	}

	wsClient = null;
	trpc = null;
	currentHost = null;
	onWsReconnect = null;

	return initializeTRPC(host);
};

const getTRPCClient = () => {
	if (!trpc) {
		throw new Error('TRPC client is not initialized');
	}

	return trpc;
};

const debugCloseCurrentWs = (opts: { code?: number; reason?: string } = {}) => {
	const ws = wsClient?.connection?.ws;

	if (!ws) {
		return false;
	}

	ws.close(opts.code ?? 4013, opts.reason ?? 'voice reconnect lab');

	return true;
};

const cleanup = (opts: { clearAuth?: boolean; ignoreSocketCloseEvent?: boolean; skipSocketClose?: boolean } = {}) => {
	clearDeferredWsReconnectOnlineListener();

	if (teardownTimer) {
		clearTimeout(teardownTimer);
		teardownTimer = null;
	}

	if (wsClient && !opts.skipSocketClose) {
		if (opts.ignoreSocketCloseEvent) {
			markSocketCloseEventIgnored(wsClient.connection?.ws);
		}

		wsClient.close();
	}
	wsClient = null;
	onWsReconnect = null;

	trpc = null;
	currentHost = null;

	resetServerScreens();
	resetServerState();
	resetDialogs();
	resetApp();

	if (opts.clearAuth) {
		clearAuthToken();
	}
};

const setOnWsReconnect = (cb: (() => void) | null) => {
	onWsReconnect = cb;
};

export { type AppRouter, cleanup, connectToTRPC, debugCloseCurrentWs, getTRPCClient, reconnectTRPC, setOnWsReconnect };
