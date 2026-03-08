import { Dialog } from '@/components/dialogs/dialogs';
import { refreshAccessToken, revokeRefreshToken } from '@/helpers/auth';
import { logDebug } from '@/helpers/browser-logger';
import { getHostFromServer } from '@/helpers/get-file-url';
import { cleanup, connectToTRPC, getTRPCClient } from '@/lib/trpc';
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
    return;
  }

  setPluginCommands({});
};

export const disconnectFromServer = () => {
  clearPendingVoiceReconnectChannelId();
  cleanup({ ignoreSocketCloseEvent: true });
  unsubscribeFromServer?.();
};

export const logoutFromServer = async () => {
  clearPendingVoiceReconnectChannelId();
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
