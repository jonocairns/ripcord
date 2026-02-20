import { resetApp } from '@/features/app/actions';
import { resetDialogs } from '@/features/dialogs/actions';
import { resetServerScreens } from '@/features/server-screens/actions';
import { currentVoiceChannelIdSelector } from '@/features/server/channels/selectors';
import { setPendingVoiceReconnectChannelId } from '@/features/server/reconnect-state';
import { resetServerState, setDisconnectInfo } from '@/features/server/actions';
import { store } from '@/features/store';
import {
  clearAuthToken,
  getAuthToken
} from '@/helpers/storage';
import { getRuntimeServerConfig } from '@/runtime/server-config';
import type { AppRouter, TConnectionParams } from '@sharkord/shared';
import { createTRPCProxyClient, createWSClient, wsLink } from '@trpc/client';

let wsClient: ReturnType<typeof createWSClient> | null = null;
let trpc: ReturnType<typeof createTRPCProxyClient<AppRouter>> | null = null;
let currentHost: string | null = null;

const initializeTRPC = (host: string) => {
  const runtimeServerUrl = getRuntimeServerConfig().serverUrl;
  const serverProtocol = runtimeServerUrl
    ? new URL(runtimeServerUrl).protocol
    : window.location.protocol;
  const protocol = serverProtocol === 'https:' ? 'wss' : 'ws';

  wsClient = createWSClient({
    url: `${protocol}://${host}`,
    // @ts-expect-error - the onclose type is not correct in trpc
    onClose: (cause: CloseEvent) => {
      const state = store.getState();
      const currentVoiceChannelId = currentVoiceChannelIdSelector(state);

      setPendingVoiceReconnectChannelId(
        !cause.wasClean ? currentVoiceChannelId : undefined
      );

      cleanup({ skipSocketClose: true });
      setDisconnectInfo({
        code: cause.code,
        reason: cause.reason,
        wasClean: cause.wasClean,
        time: new Date()
      });
    },
    connectionParams: async (): Promise<TConnectionParams> => {
      return {
        token: getAuthToken() || ''
      };
    }
  });

  trpc = createTRPCProxyClient<AppRouter>({
    links: [wsLink({ client: wsClient })]
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

const getTRPCClient = () => {
  if (!trpc) {
    throw new Error('TRPC client is not initialized');
  }

  return trpc;
};

const cleanup = (
  opts: { clearAuth?: boolean; skipSocketClose?: boolean } = {}
) => {
  if (wsClient && !opts.skipSocketClose) {
    wsClient.close();
  }
  wsClient = null;

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

export { cleanup, connectToTRPC, getTRPCClient, type AppRouter };
