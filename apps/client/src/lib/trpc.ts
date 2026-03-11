import { resetApp } from '@/features/app/actions';
import { resetDialogs } from '@/features/dialogs/actions';
import { resetServerScreens } from '@/features/server-screens/actions';
import { resetServerState, setDisconnectInfo } from '@/features/server/actions';
import { currentVoiceChannelIdSelector } from '@/features/server/channels/selectors';
import { shouldRestoreVoiceAfterDisconnect } from '@/features/server/disconnect-utils';
import { setPendingVoiceReconnectChannelId } from '@/features/server/reconnect-state';
import { useServerStore } from '@/features/server/slice';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { clearAuthToken, getAuthToken } from '@/helpers/storage';
import { getRuntimeServerConfig } from '@/runtime/server-config';
import type { AppRouter, TConnectionParams } from '@sharkord/shared';
import { DisconnectCode } from '@sharkord/shared';
import { createTRPCProxyClient, createWSClient, wsLink } from '@trpc/client';
import {
  markSocketCloseEventIgnored,
  shouldIgnoreSocketCloseEvent
} from './websocket-close-ignore';

let wsClient: ReturnType<typeof createWSClient> | null = null;
let trpc: ReturnType<typeof createTRPCProxyClient<AppRouter>> | null = null;
let currentHost: string | null = null;

// These codes represent deliberate server-side actions — retrying immediately is
// pointless (KICKED/BANNED) or premature (SERVER_SHUTDOWN). All other codes
// (e.g. 1006 UNEXPECTED) get silent tRPC-level retries before app teardown.
const DELIBERATE_DISCONNECT_CODES = new Set<number>([
  DisconnectCode.KICKED,
  DisconnectCode.BANNED,
  DisconnectCode.SERVER_SHUTDOWN
]);

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
      if (shouldIgnoreSocketCloseEvent(cause)) {
        return;
      }

      const state = useServerStore.getState();
      const wasConnected = state.connected;
      const currentVoiceChannelId = currentVoiceChannelIdSelector(state);

      if (wasConnected) {
        setPendingVoiceReconnectChannelId(
          shouldRestoreVoiceAfterDisconnect(cause.code)
            ? currentVoiceChannelId
            : undefined
        );
      }

      if (DELIBERATE_DISCONNECT_CODES.has(cause.code)) {
        // Tear down immediately for intentional server-side disconnects
        cleanup({ skipSocketClose: true });
        if (wasConnected) {
          playSound(SoundType.SERVER_DISCONNECTED);
        }
        setDisconnectInfo({
          code: cause.code,
          reason: cause.reason,
          wasClean: cause.wasClean,
          time: new Date()
        });
        return;
      }

      queueMicrotask(() => {
        cleanup({ skipSocketClose: true });
        if (wasConnected) {
          playSound(SoundType.SERVER_DISCONNECTED);
        }
        setDisconnectInfo({
          code: cause.code,
          reason: cause.reason,
          wasClean: cause.wasClean,
          time: new Date()
        });
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
  opts: {
    clearAuth?: boolean;
    ignoreSocketCloseEvent?: boolean;
    skipSocketClose?: boolean;
  } = {}
) => {
  if (wsClient && !opts.skipSocketClose) {
    if (opts.ignoreSocketCloseEvent) {
      markSocketCloseEventIgnored(wsClient.connection?.ws);
    }

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
