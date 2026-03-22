import type { AppRouter } from '@sharkord/shared/src/trpc';
import type { TConnectionParams } from '@sharkord/shared/src/types';
import { DisconnectCode } from '@sharkord/shared/src/statics';
import { createTRPCProxyClient, createWSClient, wsLink } from '@trpc/client';
import { getEffects, getServerConfigAdapter, getStorageAdapter } from './adapters';
import { currentVoiceChannelIdSelector } from './channels-selectors';
import { shouldRestoreVoiceAfterDisconnect } from './disconnect-utils';
import { getPendingVoiceReconnectChannelId, setPendingVoiceReconnectChannelId } from './reconnect-state';
import { useServerStore } from './server-store';
import type { TDisconnectInfo } from './types';
import { markSocketCloseEventIgnored, shouldIgnoreSocketCloseEvent } from './websocket-close-ignore';

type TSocketCloseEvent = {
	code: number;
	currentTarget?: EventTarget | null;
	reason: string;
	target?: EventTarget | null;
	wasClean: boolean;
};

let wsClient: ReturnType<typeof createWSClient> | null = null;
let trpc: ReturnType<typeof createTRPCProxyClient<AppRouter>> | null = null;
let currentHost: string | null = null;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
let onWsReconnect: (() => void) | null = null;

const RETRY_GRACE_PERIOD_MS = 5_000;

const DELIBERATE_DISCONNECT_CODES = new Set<number>([
	DisconnectCode.KICKED,
	DisconnectCode.BANNED,
	DisconnectCode.SERVER_SHUTDOWN,
]);

const resetCoreState = () => {
	useServerStore.getState().resetState();
	getEffects()?.onReset?.();
};

const applyDisconnectInfo = (disconnectInfo: TDisconnectInfo) => {
	useServerStore.getState().setDisconnectInfo(disconnectInfo);
	getEffects()?.onServerDisconnected?.();
};

const buildDisconnectInfo = (cause: TSocketCloseEvent): TDisconnectInfo => ({
	code: cause.code,
	reason: cause.reason,
	time: new Date(),
	wasClean: cause.wasClean,
});

const initializeTRPC = (host: string) => {
	const serverProtocol = getServerConfigAdapter().getServerProtocol();
	const protocol = serverProtocol === 'https:' ? 'wss' : 'ws';

	wsClient = createWSClient({
		connectionParams: async (): Promise<TConnectionParams> => {
			const token = await getStorageAdapter().getAuthToken();

			return {
				token: token ?? '',
			};
		},
		// @ts-expect-error tRPC currently types this callback too narrowly.
		onClose: (cause: TSocketCloseEvent) => {
			if (shouldIgnoreSocketCloseEvent(cause as Parameters<typeof shouldIgnoreSocketCloseEvent>[0])) {
				return;
			}

			const state = useServerStore.getState();
			const wasConnected = state.connected;
			const currentVoiceChannelId = currentVoiceChannelIdSelector(state);
			const pendingVoiceChannelId = getPendingVoiceReconnectChannelId();

			if (wasConnected) {
				setPendingVoiceReconnectChannelId(
					shouldRestoreVoiceAfterDisconnect(cause.code) ? (currentVoiceChannelId ?? pendingVoiceChannelId) : undefined,
				);
			}

			if (DELIBERATE_DISCONNECT_CODES.has(cause.code)) {
				cleanup({ skipSocketClose: true });

				if (wasConnected) {
					applyDisconnectInfo(buildDisconnectInfo(cause));
				}

				return;
			}

			if (teardownTimer) {
				clearTimeout(teardownTimer);
			}

			teardownTimer = setTimeout(() => {
				teardownTimer = null;
				cleanup({ skipSocketClose: true });

				if (wasConnected) {
					applyDisconnectInfo(buildDisconnectInfo(cause));
				}
			}, RETRY_GRACE_PERIOD_MS);
		},
		onOpen: () => {
			if (!teardownTimer) {
				return;
			}

			clearTimeout(teardownTimer);
			teardownTimer = null;
			onWsReconnect?.();
		},
		url: `${protocol}://${host}`,
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

const cleanup = (opts: { clearAuth?: boolean; ignoreSocketCloseEvent?: boolean; skipSocketClose?: boolean } = {}) => {
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
	trpc = null;
	currentHost = null;
	onWsReconnect = null;

	resetCoreState();

	if (opts.clearAuth) {
		void getStorageAdapter().clearAuthToken();
	}
};

const setOnWsReconnect = (callback: (() => void) | null) => {
	onWsReconnect = callback;
};

export { cleanup, connectToTRPC, getTRPCClient, reconnectTRPC, setOnWsReconnect };
export type { AppRouter };
