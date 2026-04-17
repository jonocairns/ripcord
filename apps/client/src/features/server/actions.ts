import type { TPublicServerSettings, TServerInfo } from '@sharkord/shared';
import { TRPCClientError } from '@trpc/client';
import { toast } from 'sonner';
import { Dialog } from '@/components/dialogs/dialogs';
import { refreshAccessToken, revokeRefreshToken } from '@/helpers/auth';
import { logDebug } from '@/helpers/browser-logger';
import { getHostFromServer } from '@/helpers/get-file-url';
import { cleanup, connectToTRPC, getTRPCClient, reconnectTRPC, setOnWsReconnect } from '@/lib/trpc';
import { openDialog } from '../dialogs/actions';
import { setPluginCommands } from './plugins/actions';
import {
	clearReconnectSnapshotEventBuffer,
	flushReconnectSnapshotEventBuffer,
	pauseReconnectSnapshotEventBuffer,
	startReconnectSnapshotEventBuffer,
} from './reconnect-event-buffer';
import {
	clearVoiceReconnectRecovery,
	getValidPendingVoiceReconnect,
	resolveVoiceRecoveryAction,
	useVoiceReconnectStore,
} from './voice/reconnect-coordinator';
import { infoSelector } from './selectors';
import { useServerStore } from './slice';
import { initSubscriptions } from './subscriptions';
import type { TDisconnectInfo } from './types';

let unsubscribeFromServer: (() => void) | null = null;
let connectPromise: Promise<void> | null = null;
// Incremented on each WS reconnect attempt to discard stale async work.
let wsReconnectGeneration = 0;

const didGenerationChange = (generation: number): boolean => generation !== wsReconnectGeneration;

const cleanupServerSubscriptions = () => {
	unsubscribeFromServer?.();
	unsubscribeFromServer = null;
};

export const resetServerState = () => {
	useServerStore.getState().resetState();
};

export const setDisconnectInfo = (info: TDisconnectInfo | undefined) => {
	useServerStore.getState().setDisconnectInfo(info);
};

export const setConnecting = (status: boolean) => {
	useServerStore.getState().setConnecting(status);
};

export const setMustChangePassword = (status: boolean) => {
	useServerStore.getState().setMustChangePassword(status);
};

export const setPublicServerSettings = (settings: TPublicServerSettings | undefined) => {
	useServerStore.getState().setPublicSettings(settings);
};

export const setInfo = (info: TServerInfo | undefined) => {
	useServerStore.getState().setInfo(info);
};

export const connect = async () => {
	if (connectPromise) {
		return connectPromise;
	}

	connectPromise = (async () => {
		setConnecting(true);

		const state = useServerStore.getState();
		const info = infoSelector(state);
		const serverId = info?.serverId ?? 'unknown-server';

		const attemptConnect = async () => {
			const host = getHostFromServer();
			const trpc = await connectToTRPC(host);

			const { hasPassword, handshakeHash } = await trpc.others.handshake.query();

			if (hasPassword) {
				// show password prompt
				openDialog(Dialog.SERVER_PASSWORD, { handshakeHash, serverId });
				return;
			}

			await joinServer(handshakeHash, undefined, trpc);
		};

		try {
			await attemptConnect();
		} catch (error) {
			const trpcErrorCode = error instanceof TRPCClientError ? error.data?.code : undefined;

			// Some auth failures from the WS handshake surface as TRPC "Unknown error"
			// without a typed error code. In that case, still attempt refresh.
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

export const joinServer = async (
	handshakeHash: string,
	password?: string,
	trpcClient?: ReturnType<typeof connectToTRPC>,
	opts?: { reconnect?: boolean },
) => {
	const trpc = trpcClient ?? getTRPCClient();

	try {
		const data = await trpc.others.joinServer.query({ handshakeHash, password });

		logDebug('joinServer', data);

		// A reconnect restores auth as a side effect of joinServer. Subscribing
		// before this point creates new subscriptions against an unauthenticated
		// WS context, which immediately fails and floods the client with
		// UNAUTHORIZED errors. Start subscriptions only after join succeeds, but
		// still before applying the snapshot so newer live events can be buffered
		// and replayed over the potentially stale snapshot payload.
		if (opts?.reconnect && !data.mustChangePassword) {
			startReconnectSnapshotEventBuffer();
			cleanupServerSubscriptions();
			unsubscribeFromServer = initSubscriptions();
		}

		useServerStore.getState().setInitialData(data);
		setDisconnectInfo(undefined);

		if (!data.mustChangePassword) {
			if (!opts?.reconnect) {
				cleanupServerSubscriptions();
				unsubscribeFromServer = initSubscriptions();
			}
			setPluginCommands(data.commands);
		} else {
			// mustChangePassword — no subscriptions needed on either the initial
			// connect or reconnect path.
			cleanupServerSubscriptions();
			setPluginCommands({});
		}

		if (opts?.reconnect && !data.mustChangePassword) {
			flushReconnectSnapshotEventBuffer();
		} else if (opts?.reconnect) {
			clearReconnectSnapshotEventBuffer();
		}
	} catch (error) {
		if (opts?.reconnect) {
			// Pause (not clear) so events buffered during this failed attempt are
			// preserved for the next retry. The caller is responsible for calling
			// clearReconnectSnapshotEventBuffer() on final teardown.
			pauseReconnectSnapshotEventBuffer();
		}

		throw error;
	}

	// Register the WS reconnect handler so that if tRPC silently reconnects
	// (e.g. server restart, brief network drop), we re-authenticate and
	// restore subscriptions + voice on the new server-side context.
	setOnWsReconnect(() => {
		logDebug('WS reconnected, re-joining server');

		// tRPC automatically replays existing subscriptions when the socket
		// reconnects, but the new server-side WS context starts unauthenticated.
		// Tear them down immediately so they do not all fail before joinServer
		// has a chance to restore the session.
		cleanupServerSubscriptions();

		wsReconnectGeneration += 1;
		const generation = wsReconnectGeneration;

		const attemptSilentRejoin = async (
			trpcClient?: ReturnType<typeof connectToTRPC>,
		): Promise<'joined' | 'password-required' | 'cancelled'> => {
			const trpc = trpcClient ?? getTRPCClient();
			const { hasPassword, handshakeHash } = await trpc.others.handshake.query();

			if (didGenerationChange(generation)) {
				return 'cancelled';
			}

			if (hasPassword) {
				return 'password-required';
			}

			await joinServer(handshakeHash, undefined, trpc, { reconnect: true });

			if (didGenerationChange(generation)) {
				return 'cancelled';
			}

			const state = useServerStore.getState();
			if (state.currentVoiceChannelId !== undefined) {
				// Keep the local channel sticky across WS reconnects even if the
				// server-side voice session is gone. A restarted server cannot restore
				// the mediasoup session from voiceMap, so the VoiceProvider needs the
				// original channel id to turn the next transport rebuild into a fresh
				// voice.join instead of forcing a manual rejoin.
				const channelState = state.voiceMap[state.currentVoiceChannelId];
				const ownUserId = state.ownUserId;
				const stillInVoice = ownUserId !== undefined && channelState?.users[ownUserId] !== undefined;

				if (stillInVoice) {
					logDebug('WS reconnect restored voice session', {
						channelId: state.currentVoiceChannelId,
					});
				} else {
					logDebug('WS reconnect restored server connection without a voice session; recovery will rejoin', {
						channelId: state.currentVoiceChannelId,
					});
				}

				// Recreate channel-scoped voice subscriptions against the latest WS
				// session. If the server lost the voice session, the provider will
				// fall back to a fresh voice.join when transport recovery runs.
				state.bumpVoiceSessionReconnectNonce();
			}

			const pendingVoiceReconnect = getValidPendingVoiceReconnect();

			if (pendingVoiceReconnect) {
				logDebug('Voice reconnect recovery scheduled', {
					channelId: pendingVoiceReconnect.channelId,
				});
				useVoiceReconnectStore.getState().setReconnectingSince(Date.now());
			}

			logDebug('Voice recovery action resolved', {
				recoveryAction: resolveVoiceRecoveryAction(),
			});

			return 'joined';
		};

		void (async () => {
			try {
				const result = await attemptSilentRejoin();

				if (result === 'cancelled') {
					return;
				}

				if (result === 'password-required') {
					// Can't silently reconnect to a password-protected server —
					// fall through to teardown so the user sees the password prompt
					// on next connect.
					clearReconnectSnapshotEventBuffer();
					cleanup({ ignoreSocketCloseEvent: true });
					cleanupServerSubscriptions();
				}
			} catch (error) {
				if (didGenerationChange(generation)) {
					clearReconnectSnapshotEventBuffer();
					return;
				}

				const isAuthError =
					error instanceof TRPCClientError && (!error.data?.code || error.data.code === 'UNAUTHORIZED');

				if (isAuthError) {
					const refreshed = await refreshAccessToken();

					if (didGenerationChange(generation)) {
						clearReconnectSnapshotEventBuffer();
						return;
					}

					if (refreshed) {
						logDebug('Token refreshed after WS reconnect, retrying join');

						try {
							const host = getHostFromServer();
							const trpc = reconnectTRPC(host);
							const result = await attemptSilentRejoin(trpc);

							if (result === 'joined' || result === 'cancelled') {
								return;
							}

							if (result === 'password-required') {
								clearReconnectSnapshotEventBuffer();
								cleanup({ ignoreSocketCloseEvent: true });
								cleanupServerSubscriptions();
								return;
							}
						} catch (retryError) {
							if (didGenerationChange(generation)) {
								clearReconnectSnapshotEventBuffer();
								return;
							}

							logDebug('Failed to rejoin after token refresh, tearing down', {
								error: retryError,
							});
						}
					}
				} else {
					logDebug('Failed to rejoin after WS reconnect, tearing down', {
						error,
					});
				}

				clearReconnectSnapshotEventBuffer();
				clearVoiceReconnectRecovery('app-teardown');
				cleanup({ ignoreSocketCloseEvent: true });
			}
		})();
	});
};

export const logoutFromServer = async () => {
	wsReconnectGeneration += 1;
	setOnWsReconnect(null);
	clearVoiceReconnectRecovery('logout');
	await revokeRefreshToken();
	cleanup({ clearAuth: true, ignoreSocketCloseEvent: true });
	cleanupServerSubscriptions();
};

window.useToken = async (token: string) => {
	const trpc = getTRPCClient();

	try {
		await trpc.others.useSecretToken.mutate({ token });

		toast.success('You are now an owner of this server');
	} catch {
		toast.error('Invalid access token');
	}
};
