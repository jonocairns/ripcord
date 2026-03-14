import { Dialog } from '@/components/dialogs/dialogs';
import { refreshAccessToken, revokeRefreshToken } from '@/helpers/auth';
import { logDebug } from '@/helpers/browser-logger';
import { getHostFromServer } from '@/helpers/get-file-url';
import {
  cleanup,
  connectToTRPC,
  getTRPCClient,
  reconnectTRPC,
  setOnWsReconnect
} from '@/lib/trpc';
import { type TPublicServerSettings, type TServerInfo } from '@sharkord/shared';
import { TRPCClientError } from '@trpc/client';
import { toast } from 'sonner';
import { openDialog } from '../dialogs/actions';
import { setPluginCommands } from './plugins/actions';
import { clearPendingVoiceReconnectChannelId } from './reconnect-state';
import { infoSelector } from './selectors';
import { useServerStore } from './slice';
import { initSubscriptions } from './subscriptions';
import { type TDisconnectInfo } from './types';

let unsubscribeFromServer: (() => void) | null = null;
let connectPromise: Promise<void> | null = null;
// Incremented on each WS reconnect attempt to discard stale async work.
let wsReconnectGeneration = 0;

const didGenerationChange = (generation: number): boolean =>
  generation !== wsReconnectGeneration;

export const setConnected = (status: boolean) => {
  useServerStore.getState().setConnected(status);
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

export const setServerId = (id: string) => {
  useServerStore.getState().setServerId(id);
};

export const setPublicServerSettings = (
  settings: TPublicServerSettings | undefined
) => {
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

      const { hasPassword, handshakeHash } =
        await trpc.others.handshake.query();

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
      const trpcErrorCode =
        error instanceof TRPCClientError ? error.data?.code : undefined;

      // Some auth failures from the WS handshake surface as TRPC "Unknown error"
      // without a typed error code. In that case, still attempt refresh.
      if (
        error instanceof TRPCClientError &&
        trpcErrorCode &&
        trpcErrorCode !== 'UNAUTHORIZED'
      ) {
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
  trpcClient?: ReturnType<typeof connectToTRPC>
) => {
  const trpc = trpcClient ?? getTRPCClient();
  const data = await trpc.others.joinServer.query({ handshakeHash, password });

  logDebug('joinServer', data);

  useServerStore.getState().setInitialData(data);
  setDisconnectInfo(undefined);

  unsubscribeFromServer?.();
  unsubscribeFromServer = null;

  if (!data.mustChangePassword) {
    unsubscribeFromServer = initSubscriptions();
    setPluginCommands(data.commands);
  } else {
    setPluginCommands({});
  }

  // Register the WS reconnect handler so that if tRPC silently reconnects
  // (e.g. server restart, brief network drop), we re-authenticate and
  // restore subscriptions + voice on the new server-side context.
  setOnWsReconnect(() => {
    logDebug('WS reconnected, re-joining server');

    wsReconnectGeneration += 1;
    const generation = wsReconnectGeneration;

    const attemptSilentRejoin = async (
      trpcClient?: ReturnType<typeof connectToTRPC>
    ): Promise<'joined' | 'password-required' | 'cancelled'> => {
      const trpc = trpcClient ?? getTRPCClient();
      const { hasPassword, handshakeHash } =
        await trpc.others.handshake.query();

      if (didGenerationChange(generation)) {
        return 'cancelled';
      }

      if (hasPassword) {
        return 'password-required';
      }

      await joinServer(handshakeHash, undefined, trpc);

      if (didGenerationChange(generation)) {
        return 'cancelled';
      }

      // Clear voice channel only after auth/subscriptions are restored so
      // the pending voice rejoin runs against a live server session.
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
          // Can't silently reconnect to a password-protected server —
          // fall through to teardown so the user sees the password prompt
          // on next connect.
          cleanup({ ignoreSocketCloseEvent: true });
        }
      } catch (error) {
        if (didGenerationChange(generation)) {
          return;
        }

        const isAuthError =
          error instanceof TRPCClientError &&
          (!error.data?.code || error.data.code === 'UNAUTHORIZED');

        if (isAuthError) {
          const refreshed = await refreshAccessToken();

          if (didGenerationChange(generation)) {
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
                cleanup({ ignoreSocketCloseEvent: true });
                return;
              }
            } catch (retryError) {
              if (didGenerationChange(generation)) {
                return;
              }

              logDebug('Failed to rejoin after token refresh, tearing down', {
                error: retryError
              });
            }
          }
        } else {
          logDebug('Failed to rejoin after WS reconnect, tearing down', {
            error
          });
        }

        cleanup({ ignoreSocketCloseEvent: true });
      }
    })();
  });
};

export const disconnectFromServer = () => {
  wsReconnectGeneration += 1;
  clearPendingVoiceReconnectChannelId();
  setOnWsReconnect(null);
  cleanup({ ignoreSocketCloseEvent: true });
  unsubscribeFromServer?.();
};

export const logoutFromServer = async () => {
  wsReconnectGeneration += 1;
  clearPendingVoiceReconnectChannelId();
  setOnWsReconnect(null);
  await revokeRefreshToken();
  cleanup({ clearAuth: true, ignoreSocketCloseEvent: true });
  unsubscribeFromServer?.();
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
