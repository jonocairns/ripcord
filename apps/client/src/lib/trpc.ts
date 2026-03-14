import { resetApp } from '@/features/app/actions';
import { resetDialogs } from '@/features/dialogs/actions';
import { resetServerScreens } from '@/features/server-screens/actions';
import { resetServerState, setDisconnectInfo } from '@/features/server/actions';
import { currentVoiceChannelIdSelector } from '@/features/server/channels/selectors';
import { shouldRestoreVoiceAfterDisconnect } from '@/features/server/disconnect-utils';
import {
  getPendingVoiceReconnectChannelId,
  setPendingVoiceReconnectChannelId
} from '@/features/server/reconnect-state';
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
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
let onWsReconnect: (() => void) | null = null;

// How long to wait for tRPC to reconnect before tearing down the app state.
const RETRY_GRACE_PERIOD_MS = 5000;

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
      const pendingVoiceChannelId = getPendingVoiceReconnectChannelId();

      if (wasConnected) {
        setPendingVoiceReconnectChannelId(
          shouldRestoreVoiceAfterDisconnect(cause.code)
            ? (currentVoiceChannelId ?? pendingVoiceChannelId)
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
          time: new Date()
        });
      }, RETRY_GRACE_PERIOD_MS);
    },
    onOpen: () => {
      if (teardownTimer) {
        clearTimeout(teardownTimer);
        teardownTimer = null;

        // The WS reconnected after a disconnect. The new server-side context
        // is unauthenticated (authenticated: false in createContext), so we
        // need to re-run handshake → joinServer to restore auth, subscriptions,
        // and voice state.
        onWsReconnect?.();
      }
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

export {
  cleanup,
  connectToTRPC,
  getTRPCClient,
  reconnectTRPC,
  setOnWsReconnect,
  type AppRouter
};
