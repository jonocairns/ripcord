import type { AppRouter, TConnectionParams } from '@sharkord/shared';
import { DisconnectCode } from '@sharkord/shared';
import { createTRPCProxyClient, createWSClient, wsLink } from '@trpc/client';
import { resetApp } from '@/features/app/actions';
import { resetDialogs } from '@/features/dialogs/actions';
import { resetServerState, setDisconnectInfo } from '@/features/server/actions';
import { shouldRestoreVoiceAfterDisconnect } from '@/features/server/disconnect-utils';
import { useServerStore } from '@/features/server/slice';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { clearVoiceReconnectRecovery, reportVoiceSocketDropped } from '@/features/server/voice/reconnect-coordinator';
import { isVoiceReconnectOnline } from '@/features/server/voice/reconnect-lab-debug';
import { resetServerScreens } from '@/features/server-screens/actions';
import { recordVoiceDiagnostic } from '@/helpers/browser-logger';
import { recordDesktopDiagnostic } from '@/helpers/desktop-diagnostics';
import { setErrorReportingIdentity } from '@/helpers/error-reporting';
import {
	authenticateDiagnosticDelivery,
	clearDiagnosticDelivery,
	pauseDiagnosticDelivery,
} from '@/helpers/error-reporting/delivery';
import { clearAuthToken, getAuthToken } from '@/helpers/storage';
import {
	authenticateStreamObservability,
	clearStreamObservability,
	pauseStreamObservability,
} from '@/helpers/stream-observability';
import { stopClientTracing } from '@/helpers/telemetry/backend';
import { getRuntimeServerConfig } from '@/runtime/server-config';
import { createConnectionStore, type TConnectionCommand } from './connection-state';
import { createSessionAuthenticationGate } from './session-authentication-gate';
import { streamDiagnosticsLink } from './stream-diagnostics-link';
import { tracingLink } from './tracing-link';

let wsClient: ReturnType<typeof createWSClient> | null = null;
let trpc: ReturnType<typeof createTRPCProxyClient<AppRouter>> | null = null;
let currentHost: string | null = null;
let graceTimerHandle: ReturnType<typeof setTimeout> | null = null;
let serverRejoinHandler: (() => void) | null = null;
let cachedClientInstanceId: string | null = null;
let deferredWsReconnectOnlineListener: (() => void) | null = null;
const connection = createConnectionStore();
const getServerConnectionState = () => connection.getState();
const subscribeServerConnectionState = (listener: () => void) => connection.subscribe(listener);
let lastDrop: { code: number; reason: string; wasClean: boolean; wasConnected: boolean } | null = null;
const sessionAuthentication = createSessionAuthenticationGate();

// WebSocket keep-alive (zombie-socket detection). The ping timer resets on any
// received message, so on an active connection these rarely fire. The pong
// timeout is deliberately generous (Discord-style forgiveness): it tolerates a
// multi-second server event-loop stall and absorbs background-tab timer
// throttling on web, so a live-but-laggy connection is not falsely closed on a
// single slow heartbeat. Effective silence tolerance before a close is
// interval + pongTimeout (~35s) — still far faster than the old "never".
const WS_KEEPALIVE_PING_INTERVAL_MS = 15_000;
const WS_KEEPALIVE_PONG_TIMEOUT_MS = 20_000;

// Jitter window for the first reconnect attempt. A server-wide event (an
// event-loop stall tripping keepAlive on every client at once, a restart) closes
// many sockets simultaneously; without jitter they all reconnect on the same
// tick and stampede the server with re-handshake + restoreOrJoin. Kept well
// under the unauthenticated grace period so attempt 0 still resolves before app teardown.
const WS_RECONNECT_INITIAL_JITTER_MS = 1_000;

// Reconnect backoff that mirrors tRPC's default exponential shape (prompt first
// attempt, then 2^n capped at 30s) but adds jitter so simultaneously-dropped
// clients decorrelate instead of reconnecting in lockstep.
const reconnectRetryDelayMs = (attemptIndex: number): number => {
	const base = attemptIndex === 0 ? 0 : Math.min(1_000 * 2 ** attemptIndex, 30_000);
	const jitter = attemptIndex === 0 ? Math.random() * WS_RECONNECT_INITIAL_JITTER_MS : Math.random() * base * 0.5;

	return base + jitter;
};

const WS_CLIENT_INSTANCE_ID_STORAGE_KEY = 'ripcord.ws-client-instance-id';

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

const retireTRPCClient = () => {
	const client = wsClient;
	wsClient = null;
	trpc = null;
	currentHost = null;
	serverRejoinHandler = null;
	// Clear ownership before close() can notify callbacks; it disables retries synchronously.
	void client?.close().catch(() => {});
};

const initializeTRPC = (host: string) => {
	const runtimeServerUrl = getRuntimeServerConfig().serverUrl;
	const serverProtocol = runtimeServerUrl ? new URL(runtimeServerUrl).protocol : window.location.protocol;
	const protocol = serverProtocol === 'https:' ? 'wss' : 'ws';
	const tokenOrigin = new URL(`${serverProtocol}//${host}`).origin;

	// tRPC prepares the URL in a promise before creating the socket, so callbacks run after assignment.
	const client = createWSClient({
		url: `${protocol}://${host}`,
		retryDelayMs: reconnectRetryDelayMs,
		// Application-level liveness probe. A WebSocket can become a "zombie" on a
		// half-open network drop (sleep/wake, Wi-Fi↔cellular handoff, NAT/VPN
		// rebind) where neither side ever receives a FIN/RST — the browser then
		// never fires `onClose`, so the client keeps showing the user in voice with
		// no audio while the server has already reaped the session. keepAlive sends
		// a PING and force-closes the socket when no PONG arrives, which routes
		// through `onClose` below into the normal voice-reconnect machinery.
		keepAlive: {
			enabled: true,
			intervalMs: WS_KEEPALIVE_PING_INTERVAL_MS,
			pongTimeoutMs: WS_KEEPALIVE_PONG_TIMEOUT_MS,
		},
		// @ts-expect-error - the onclose type is not correct in trpc
		onClose: (cause: CloseEvent) => {
			if (wsClient !== client) {
				return;
			}
			recordVoiceDiagnostic(
				'Voice WebSocket closed',
				[
					{
						clientInstanceId: getWsClientInstanceId(),
						closeCode: cause.code,
						wasClean: cause.wasClean,
						online: isVoiceReconnectOnline(),
						wasConnected: useServerStore.getState().connected,
					},
				],
				'warning',
			);
			recordDesktopDiagnostic(
				'websocket_closed',
				{
					clientInstanceId: getWsClientInstanceId(),
					code: cause.code,
					reason: cause.reason,
					wasClean: cause.wasClean,
					online: isVoiceReconnectOnline(),
					wasConnected: useServerStore.getState().connected,
				},
				'warn',
			);
			const wasConnected = useServerStore.getState().connected;
			const terminal = !shouldRestoreVoiceAfterDisconnect(cause.code);
			if (!terminal) lastDrop = { code: cause.code, reason: cause.reason, wasClean: cause.wasClean, wasConnected };
			run(connection.dispatch({ type: 'socket-closed', terminal, now: performance.now() }));

			if (terminal) {
				// Tear down immediately for intentional server-side disconnects
				if (cause.code === DisconnectCode.KICKED) {
					clearVoiceReconnectRecovery('kicked');
				} else if (cause.code === DisconnectCode.BANNED) {
					clearVoiceReconnectRecovery('banned');
				}
				cleanup();
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
		},
		onOpen: () => {
			if (wsClient !== client) {
				// tRPC close() waits for pending requests before closing the socket,
				// and an in-flight request can call open() and re-enable retries.
				// Retired clients must close even if that work finishes after retirement.
				void client.close().catch(() => {});
				client.connection?.ws.close();
				return;
			}
			recordDesktopDiagnostic('websocket_opened', {
				clientInstanceId: getWsClientInstanceId(),
				reconnecting: connection.getState().resumePending,
			});
			run(
				connection.dispatch({
					type: 'socket-opened',
					online: isVoiceReconnectOnline(),
					socketOpen: isTRPCSocketOpen(),
					now: performance.now(),
				}),
			);
		},
		connectionParams: async (): Promise<TConnectionParams> => {
			return {
				token: getAuthToken(tokenOrigin) || '',
				clientInstanceId: getWsClientInstanceId(),
			};
		},
	});

	wsClient = client;
	trpc = createTRPCProxyClient<AppRouter>({
		links: [streamDiagnosticsLink, tracingLink, wsLink({ client })],
	});

	currentHost = host;

	return trpc;
};

const connectToTRPC = (host: string) => {
	if (trpc && currentHost === host) {
		return trpc;
	}

	return reconnectTRPC(host);
};

const reconnectTRPC = (host: string) => {
	run(connection.dispatch({ type: 'client-started' }));

	return initializeTRPC(host);
};

// Thrown when a caller reaches for the client after cleanup() has nulled it —
// i.e. the socket is down. That is an expected consequence of disconnecting, not
// a defect, so reporting boundaries can recognize it and skip the Sentry report
// instead of filing a generic "TRPC client is not initialized" error on every
// connection drop that races an in-flight call.
class TRPCClientUnavailableError extends Error {
	constructor() {
		super('TRPC client is not initialized');
		this.name = 'TRPCClientUnavailableError';
	}
}

const getTRPCClient = () => {
	if (!trpc) {
		throw new TRPCClientUnavailableError();
	}

	return trpc;
};

// Attempts survive socket reopen; only retirement invalidates client ownership.
const captureTRPCAttempt = () => {
	const client = trpc;
	const epoch = connection.getState().clientEpoch;
	return () => client !== null && client === trpc && epoch === connection.getState().clientEpoch;
};

const getTRPCClientIfInitialized = () => trpc;

const markTRPCSessionAuthenticated = (client: ReturnType<typeof createTRPCProxyClient<AppRouter>>) => {
	if (client === trpc && isTRPCSocketOpen()) {
		run(connection.dispatch({ type: 'session-authenticated' }));
	}
};

const waitForTRPCSessionAuthentication = (signal: AbortSignal): Promise<void> => {
	if (!trpc) return Promise.reject(new TRPCClientUnavailableError());
	// close() changes readyState before its close event invalidates the gate.
	if (!isTRPCSocketOpen()) run(connection.dispatch({ type: 'socket-observed-closed', now: performance.now() }));
	return sessionAuthentication.wait(signal);
};

const isTRPCSocketOpen = () =>
	typeof WebSocket !== 'undefined' && wsClient?.connection?.ws?.readyState === WebSocket.OPEN;

const debugCloseCurrentWs = (opts: { code?: number; reason?: string } = {}) => {
	const ws = wsClient?.connection?.ws;

	if (!ws) {
		return false;
	}

	ws.close(opts.code ?? 4013, opts.reason ?? 'voice reconnect lab');

	return true;
};

const cleanup = (opts: { clearAuth?: boolean } = {}) => {
	lastDrop = null;
	run(connection.dispatch({ type: 'cleaned-up', reason: new TRPCClientUnavailableError() }));

	resetServerScreens();
	resetServerState();
	resetDialogs();
	resetApp();

	if (opts.clearAuth) {
		clearAuthToken();
	}
};

const armServerRejoin = (handler: () => void, { passwordChangeRequired }: { passwordChangeRequired: boolean }) => {
	serverRejoinHandler = handler;
	run(connection.dispatch({ type: 'join-completed', passwordChangeRequired }));
};
const disarmServerRejoin = () => {
	run(connection.dispatch({ type: 'rejoin-disarmed' }));
};

const run = (commands: TConnectionCommand[]) => {
	for (const command of commands) {
		switch (command.type) {
			case 'invalidate-session':
				sessionAuthentication.invalidate();
				break;
			case 'authenticate-session':
				lastDrop = null;
				sessionAuthentication.authenticate();
				break;
			case 'cancel-session':
				sessionAuthentication.cancel(command.reason);
				break;
			case 'pause-telemetry':
				pauseStreamObservability();
				pauseDiagnosticDelivery();
				stopClientTracing();
				break;
			case 'authenticate-telemetry':
				authenticateStreamObservability();
				authenticateDiagnosticDelivery();
				break;
			case 'clear-telemetry':
				clearStreamObservability();
				clearDiagnosticDelivery();
				stopClientTracing();
				setErrorReportingIdentity();
				break;
			case 'clear-online-listener':
				clearDeferredWsReconnectOnlineListener();
				break;
			case 'await-online':
				clearDeferredWsReconnectOnlineListener();
				if (typeof window === 'undefined') break;
				deferredWsReconnectOnlineListener = () => {
					run(connection.dispatch({ type: 'online', socketOpen: isTRPCSocketOpen(), now: performance.now() }));
				};
				window.addEventListener('online', deferredWsReconnectOnlineListener, { once: true });
				break;
			case 'arm-grace-timer':
				if (graceTimerHandle) clearTimeout(graceTimerHandle);
				graceTimerHandle = setTimeout(() => {
					graceTimerHandle = null;
					run(connection.dispatch({ type: 'grace-expired', online: isVoiceReconnectOnline() }));
				}, command.delayMs);
				break;
			case 'clear-grace-timer':
				if (graceTimerHandle) {
					clearTimeout(graceTimerHandle);
					graceTimerHandle = null;
				}
				break;
			case 'retire-client':
				retireTRPCClient();
				break;
			case 'voice-socket-dropped':
				reportVoiceSocketDropped();
				break;
			case 'run-rejoin':
				serverRejoinHandler?.();
				break;
			case 'teardown-to-disconnect-screen': {
				const drop = lastDrop;
				cleanup();
				if (!drop || drop.wasConnected) playSound(SoundType.SERVER_DISCONNECTED);
				setDisconnectInfo({
					code: drop?.code ?? DisconnectCode.UNEXPECTED,
					reason: drop?.reason ?? '',
					wasClean: drop?.wasClean ?? false,
					time: new Date(),
				});
				break;
			}
		}
	}
};

export {
	type AppRouter,
	armServerRejoin,
	captureTRPCAttempt,
	cleanup,
	connectToTRPC,
	debugCloseCurrentWs,
	disarmServerRejoin,
	getServerConnectionState,
	getTRPCClient,
	getTRPCClientIfInitialized,
	getWsClientInstanceId,
	isTRPCSocketOpen,
	markTRPCSessionAuthenticated,
	reconnectTRPC,
	subscribeServerConnectionState,
	TRPCClientUnavailableError,
	waitForTRPCSessionAuthentication,
};

export const isTRPCSessionAuthenticated = (): boolean =>
	connection.getState().phase.name === 'ready' && isTRPCSocketOpen();
