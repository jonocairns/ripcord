import type { TPublicServerSettings, TServerInfo } from '@sharkord/shared';
import { TRPCClientError } from '@trpc/client';
import { getEffects, getServerConfigAdapter } from './adapters';
import { fetchServerInfo, refreshAccessToken, revokeRefreshToken } from './http';
import { clearPendingVoiceReconnectChannelId } from './reconnect-state';
import { infoSelector } from './selectors';
import { useServerStore } from './server-store';
import { initSubscriptions, setPluginCommands } from './subscriptions';
import { cleanup, connectToTRPC, getTRPCClient, reconnectTRPC, setOnWsReconnect } from './trpc';
import type { TDisconnectInfo } from './types';

let unsubscribeFromServer: (() => void) | null = null;
let connectPromise: Promise<void> | null = null;
let wsReconnectGeneration = 0;

const didGenerationChange = (generation: number): boolean => generation !== wsReconnectGeneration;

const cleanupServerSubscriptions = () => {
	unsubscribeFromServer?.();
	unsubscribeFromServer = null;
};

const setConnected = (connected: boolean) => {
	useServerStore.getState().setConnected(connected);
};

const resetServerState = () => {
	useServerStore.getState().resetState();
};

const setDisconnectInfo = (disconnectInfo: TDisconnectInfo | undefined) => {
	useServerStore.getState().setDisconnectInfo(disconnectInfo);
};

const setConnecting = (connecting: boolean) => {
	useServerStore.getState().setConnecting(connecting);
};

const setMustChangePassword = (mustChangePassword: boolean) => {
	useServerStore.getState().setMustChangePassword(mustChangePassword);
};

const setServerId = (serverId: string) => {
	useServerStore.getState().setServerId(serverId);
};

const setPublicServerSettings = (publicSettings: TPublicServerSettings | undefined) => {
	useServerStore.getState().setPublicSettings(publicSettings);
};

const setInfo = (info: TServerInfo | undefined) => {
	useServerStore.getState().setInfo(info);
	getEffects()?.onServerInfoLoaded?.(info);
};

const loadServerInfo = async () => {
	const info = await fetchServerInfo();
	setInfo(info);
	return info;
};

const connect = async () => {
	if (connectPromise) {
		return connectPromise;
	}

	connectPromise = (async () => {
		setConnecting(true);

		const state = useServerStore.getState();
		const info = infoSelector(state);
		const serverId = info?.serverId ?? 'unknown-server';

		const attemptConnect = async () => {
			const host = getServerConfigAdapter().getServerHost();
			const trpc = await connectToTRPC(host);
			const { handshakeHash, hasPassword } = await trpc.others.handshake.query();

			if (hasPassword) {
				getEffects()?.onPasswordRequired?.({ handshakeHash, serverId });
				return;
			}

			await joinServer(handshakeHash, undefined, trpc);
		};

		try {
			await attemptConnect();
		} catch (error) {
			const trpcErrorCode = error instanceof TRPCClientError ? error.data?.code : undefined;

			if (error instanceof TRPCClientError && trpcErrorCode && trpcErrorCode !== 'UNAUTHORIZED') {
				throw error;
			}

			const refreshed = await refreshAccessToken();

			if (!refreshed) {
				throw error;
			}

			cleanup({ ignoreSocketCloseEvent: true });
			await attemptConnect();
		} finally {
			setConnecting(false);
			connectPromise = null;
		}
	})();

	return connectPromise;
};

const joinServer = async (handshakeHash: string, password?: string, trpcClient?: ReturnType<typeof connectToTRPC>) => {
	const trpc = trpcClient ?? getTRPCClient();
	const data = await trpc.others.joinServer.query({ handshakeHash, password });

	useServerStore.getState().setInitialData(data);
	setDisconnectInfo(undefined);
	cleanupServerSubscriptions();

	if (!data.mustChangePassword) {
		unsubscribeFromServer = initSubscriptions();
		setPluginCommands(data.commands);
	} else {
		setPluginCommands({});
	}

	setOnWsReconnect(() => {
		wsReconnectGeneration += 1;
		const generation = wsReconnectGeneration;

		const attemptSilentRejoin = async (
			nextClient?: ReturnType<typeof connectToTRPC>,
		): Promise<'joined' | 'password-required' | 'cancelled'> => {
			const client = nextClient ?? getTRPCClient();
			const { handshakeHash: nextHandshakeHash, hasPassword } = await client.others.handshake.query();

			if (didGenerationChange(generation)) {
				return 'cancelled';
			}

			if (hasPassword) {
				return 'password-required';
			}

			await joinServer(nextHandshakeHash, undefined, client);

			if (didGenerationChange(generation)) {
				return 'cancelled';
			}

			useServerStore.getState().setCurrentVoiceChannelId(undefined);
			return 'joined';
		};

		void (async () => {
			try {
				const result = await attemptSilentRejoin();

				if (result === 'cancelled') {
					return;
				}

				if (result === 'password-required') {
					cleanup({ ignoreSocketCloseEvent: true });
					cleanupServerSubscriptions();
				}
			} catch (error) {
				if (didGenerationChange(generation)) {
					return;
				}

				const isAuthError =
					error instanceof TRPCClientError && (!error.data?.code || error.data.code === 'UNAUTHORIZED');

				if (isAuthError && (await refreshAccessToken())) {
					if (didGenerationChange(generation)) {
						return;
					}

					try {
						const host = getServerConfigAdapter().getServerHost();
						const nextClient = reconnectTRPC(host);
						const result = await attemptSilentRejoin(nextClient);

						if (result === 'joined' || result === 'cancelled') {
							return;
						}

						if (result === 'password-required') {
							cleanup({ ignoreSocketCloseEvent: true });
							cleanupServerSubscriptions();
							return;
						}
					} catch {
						// fall through to cleanup below
					}
				}

				cleanup({ ignoreSocketCloseEvent: true });
			}
		})();
	});
};

const disconnectFromServer = () => {
	wsReconnectGeneration += 1;
	clearPendingVoiceReconnectChannelId();
	setOnWsReconnect(null);
	cleanup({ ignoreSocketCloseEvent: true });
	cleanupServerSubscriptions();
};

const logoutFromServer = async () => {
	wsReconnectGeneration += 1;
	clearPendingVoiceReconnectChannelId();
	setOnWsReconnect(null);
	await revokeRefreshToken();
	cleanup({ clearAuth: true, ignoreSocketCloseEvent: true });
	cleanupServerSubscriptions();
};

export {
	connect,
	disconnectFromServer,
	loadServerInfo,
	logoutFromServer,
	joinServer,
	resetServerState,
	setConnected,
	setConnecting,
	setDisconnectInfo,
	setInfo,
	setMustChangePassword,
	setPublicServerSettings,
	setServerId,
};
