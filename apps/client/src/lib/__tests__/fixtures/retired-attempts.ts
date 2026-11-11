import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { DisconnectCode } from '@sharkord/shared';
import type { TDisconnectInfo } from '@/features/server/types';

const effects: string[] = [];
const trace: string[] = [];
let online = true;
let captureVoice = false;
let pendingVoice = false;
let mustChangePassword = false;
const push = (name: string) => {
	effects.push(name);
	trace.push(name);
};
const { createSessionAuthenticationGate: realGate } = await import('../../session-authentication-gate');
mock.module('@/lib/session-authentication-gate', () => ({
	createSessionAuthenticationGate: () => {
		const gate = realGate();
		return {
			wait: gate.wait,
			invalidate: () => {
				trace.push('gate:invalidate');
				gate.invalidate();
			},
			authenticate: () => {
				trace.push('gate:authenticate');
				gate.authenticate();
			},
			cancel: (reason: unknown) => {
				trace.push('gate:cancel');
				gate.cancel(reason);
			},
		};
	},
}));
let now = 0;
Object.defineProperty(performance, 'now', { value: () => now });
let captureShortTimers = false;
const capturing = (step: () => void) => {
	captureShortTimers = true;
	try {
		step();
	} finally {
		captureShortTimers = false;
	}
};
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const timers = new Map<unknown, { callback: () => void; live: boolean }>();
globalThis.setTimeout = Object.assign((callback: TimerHandler, delay?: number) => {
	if (!captureShortTimers && (delay ?? 0) < 1000) return nativeSetTimeout(callback, delay);
	assert.equal(typeof callback, 'function');
	const id = nativeSetTimeout(() => {}, 0);
	timers.set(id, {
		callback: () => {
			if (typeof callback === 'function') callback();
		},
		live: true,
	});
	trace.push(`timer:arm:${delay}`);
	return id;
}, nativeSetTimeout);
globalThis.clearTimeout = (id) => {
	if (id !== undefined && timers.has(id)) {
		trace.push('timer:clear');
		const timer = timers.get(id);
		if (timer) timer.live = false;
	} else Reflect.apply(nativeClearTimeout, globalThis, [id]);
};
const liveTimers = () => [...timers.values()].filter((timer) => timer.live);
const fireTimer = () => {
	const live = liveTimers();
	assert.equal(live.length, 1);
	const timer = live[0];
	assert.ok(timer);
	timer.live = false;
	trace.push('timer:fire');
	timer.callback();
};
const listeners = new Map<() => void, boolean>();
const fireOnline = () => {
	for (const [fn, once] of [...listeners]) {
		if (once) listeners.delete(fn);
		fn();
	}
};
const noop = () => {};
const record = (name: string) => () => {
	push(name);
};
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
let disconnectInfo: TDisconnectInfo | undefined;
const state = {
	connected: true,
	connecting: false,
	resetState: () => {
		disconnectInfo = undefined;
		push('reset');
	},
	setConnecting: (value: boolean) => {
		state.connecting = value;
		push(`loading:${value}`);
	},
	setInitialData: record('snapshot'),
	setDisconnectInfo: (info: TDisconnectInfo | undefined) => {
		disconnectInfo = info;
		trace.push(info ? `disconnectInfo:${info.code}` : 'disconnectInfo:cleared');
	},
	bumpServerRejoinNonce: record('nonce'),
};
const modules: Record<string, string[]> = {
	'@/features/app/actions': ['resetApp'],
	'@/features/dialogs/actions': ['resetDialogs', 'openDialog'],
	'@/features/server/sounds/actions': ['playSound'],
	'@/features/server/voice/reconnect-coordinator': [
		'captureVoiceReconnectIntentForCurrentSession',
		'clearVoiceReconnectRecovery',
		'ensureVoiceReconnectStarted',
		'markVoiceReconnectSessionAuthenticated',
		'markVoiceReconnectSessionUnauthenticated',
		'getValidPendingVoiceReconnect',
		'resolveVoiceRecoveryAction',
	],
	'@/features/server/voice/reconnect-lab-debug': ['isVoiceReconnectOnline'],
	'@/features/server-screens/actions': ['resetServerScreens'],
	'@/helpers/browser-logger': ['recordVoiceDiagnostic', 'logDebug', 'setErrorReportingUser'],
	'@/helpers/desktop-diagnostics': ['recordDesktopDiagnostic'],
	'@/helpers/error-reporting': ['setErrorReportingIdentity'],
	'@/helpers/error-reporting/delivery': [
		'authenticateDiagnosticDelivery',
		'clearDiagnosticDelivery',
		'pauseDiagnosticDelivery',
		'configureDiagnosticDelivery',
	],
	'@/helpers/storage': ['clearAuthToken', 'getAuthToken'],
	'@/helpers/stream-observability': [
		'authenticateStreamObservability',
		'clearStreamObservability',
		'pauseStreamObservability',
		'configureStreamObservability',
		'getStreamClientSessionId',
	],
	'@/helpers/telemetry/backend': ['stopClientTracing', 'configureTraceBackend'],
	'@/features/server/plugins/actions': ['setPluginCommands'],
};
for (const [path, names] of Object.entries(modules)) {
	mock.module(path, () => Object.fromEntries(names.map((name) => [name, record(name)])));
}
mock.module('@/features/server/voice/reconnect-lab-debug', () => ({ isVoiceReconnectOnline: () => online }));
mock.module('@/features/server/voice/reconnect-coordinator', () =>
	Object.fromEntries(
		(modules['@/features/server/voice/reconnect-coordinator'] ?? []).map((name) => [
			name,
			(...args: unknown[]) => {
				effects.push(name);
				trace.push(name === 'clearVoiceReconnectRecovery' ? `${name}:${args[0]}` : name);
				if (name === 'captureVoiceReconnectIntentForCurrentSession') return captureVoice ? true : undefined;
				if (name === 'getValidPendingVoiceReconnect') return pendingVoice ? {} : undefined;
				return undefined;
			},
		]),
	),
);
mock.module('@/helpers/desktop-diagnostics', () => ({
	recordDesktopDiagnostic: (event: string, data: { reconnecting?: boolean }) => {
		effects.push('recordDesktopDiagnostic');
		trace.push(
			`recordDesktopDiagnostic:${event}${event === 'websocket_opened' ? `:reconnecting=${data.reconnecting}` : ''}`,
		);
	},
}));
mock.module('@/features/server/reconnect-event-buffer', () =>
	Object.fromEntries(
		[
			'clearReconnectSnapshotEventBuffer',
			'flushReconnectSnapshotEventBuffer',
			'pauseReconnectSnapshotEventBuffer',
			'startReconnectSnapshotEventBuffer',
		].map((name) => [name, record(name)]),
	),
);
mock.module('@/features/server/slice', () => ({ useServerStore: { getState: () => state } }));
mock.module('@/features/server/selectors', () => ({ infoSelector: () => undefined }));
mock.module('@/features/server/subscriptions', () => ({ initSubscriptions: () => noop }));
mock.module('@/runtime/server-config', () => ({ getRuntimeServerConfig: () => ({ serverUrl: 'http://localhost' }) }));
mock.module('@/helpers/get-file-url', () => ({ getHostFromServer: () => 'first' }));
let hasAuth = true;
mock.module('@/helpers/storage', () => ({
	getAuthToken: () => (hasAuth ? 'token' : undefined),
	getRefreshToken: () => (hasAuth ? 'refresh' : undefined),
	clearAuthToken: () => {
		hasAuth = false;
		push('clearAuthToken');
	},
}));
const refresh = deferred<boolean>();
mock.module('@/helpers/auth', () => ({
	refreshAccessToken: () => {
		push('refresh');
		return refresh.promise;
	},
	revokeRefreshToken: noop,
}));
mock.module('@/components/dialogs/dialogs', () => ({ Dialog: {} }));
mock.module('@/lib/stream-diagnostics-link', () => ({ streamDiagnosticsLink: noop }));
mock.module('@/lib/tracing-link', () => ({ tracingLink: noop }));
mock.module('sonner', () => ({ toast: {} }));

const sockets: {
	onOpen: () => void;
	onClose: (event: object) => void;
	close: () => Promise<void>;
	connection: { ws: { readyState: number; close: () => void } };
}[] = [];
let handshake = deferred<{ hasPassword: boolean; handshakeHash: string }>();
const join = deferred<{ mustChangePassword: boolean; commands: object }>();
let holdHandshake = false;
let holdJoin = false;
class MockTRPCClientError extends Error {
	constructor(
		message: string,
		readonly data?: { code: string },
	) {
		super(message);
	}
}
mock.module('@trpc/client', () => ({
	TRPCClientError: MockTRPCClientError,
	wsLink: noop,
	createWSClient: (options: { onOpen: () => void; onClose: (event: object) => void }) => {
		const socket = {
			...options,
			close: async () => {
				push('close');
			},
			connection: { ws: { readyState: 1, close: record('raw-close') } },
		};
		sockets.push(socket);
		return socket;
	},
	createTRPCProxyClient: () => ({
		others: {
			handshake: {
				query: () => {
					trace.push('handshake');
					return holdHandshake ? handshake.promise : Promise.resolve({ hasPassword: false, handshakeHash: 'hash' });
				},
			},
			joinServer: {
				query: () => {
					trace.push('join');
					return holdJoin ? join.promise : Promise.resolve({ mustChangePassword, commands: {} });
				},
			},
		},
	}),
}));
// Browser/module-load dependencies are mocked explicitly; run in an isolated process.
Object.assign(globalThis, {
	window: {
		addEventListener: (type: string, fn: () => void, options?: { once?: boolean }) => {
			trace.push(`listener:add:${type}`);
			listeners.set(fn, options?.once ?? false);
		},
		removeEventListener: (type: string, fn: () => void) => {
			trace.push(`listener:remove:${type}`);
			listeners.delete(fn);
		},
	},
	WebSocket: { OPEN: 1 },
});
const { createConnectionStore: realConnectionStore, ...connectionExports } = await import('../../connection-state');
let readConnectionState: (() => import('../../connection-state').TConnectionState) | undefined;
mock.module('@/lib/connection-state', () => ({
	...connectionExports,
	createConnectionStore: () => {
		const store = realConnectionStore();
		readConnectionState = store.getState;
		return store;
	},
}));
const trpc = await import('../../trpc');
const actions = await import('../../../features/server/actions');
const mode = process.argv[2];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const newModes = [
	'read-connection-state',
	'deadline-stalled-join',
	'deadline-replacement',
	'deadline-must-change-password',
	'deadline-join-on-closing-socket',
	'deadline-budget',
	'deadline-authenticated-clears',
	'deadline-cleanup-clears',
	'deadline-lastdrop-isolation',
	'deadline-offline-online-open',
	'deadline-offline-online-closed',
	'deadline-offline-replace-online-closed',
	'deadline-offline-replace-online-open',
	'deadline-offline-replace-authenticated',
	'deadline-offline-replace-cleanup',
	'deadline-offline',
	'deadline-wasconnected-false',

	'trace-connect',
	'trace-drop-resume',
	'trace-drop-resume-voice',
	'trace-terminal-kicked',
	'trace-terminal-banned',
	'trace-terminal-after-drop',
	'trace-cleanup',
	'trace-cleanup-pending',
	'trace-replace',
	'trace-replace-pending',
	'trace-grace-expiry',
	'grace-rearm',
	'grace-offline',
	'open-offline-defer',
	'open-offline-socket-closed',
	'open-online-socket-closed',
	'open-without-drop',
	'first-connect-drop',
	'must-change-password',
	'edge-b-replacement-drop',
	'edge-c-online',
	'edge-c-expiry',
	'gate',
	'gate-readystate',
];
const literalTraces: Record<string, string[]> = {
	'trace-connect': [
		'loading:true',
		'pauseStreamObservability',
		'pauseDiagnosticDelivery',
		'stopClientTracing',
		'gate:invalidate',
		'handshake',
		'join',
		'logDebug',
		'snapshot',
		'disconnectInfo:cleared',
		'setErrorReportingUser',
		'configureDiagnosticDelivery',
		'setErrorReportingIdentity',
		'configureStreamObservability',
		'getStreamClientSessionId',
		'configureTraceBackend',
		'setPluginCommands',
		'gate:authenticate',
		'markVoiceReconnectSessionAuthenticated',
		'authenticateStreamObservability',
		'authenticateDiagnosticDelivery',
		'recordVoiceDiagnostic',
		'loading:false',
	],
	'trace-drop-resume': [
		'recordVoiceDiagnostic',
		'recordDesktopDiagnostic:websocket_closed',
		'gate:invalidate',
		'pauseStreamObservability',
		'pauseDiagnosticDelivery',
		'stopClientTracing',
		'markVoiceReconnectSessionUnauthenticated',
		'captureVoiceReconnectIntentForCurrentSession',
		'timer:arm:45000',
		'recordDesktopDiagnostic:websocket_opened:reconnecting=true',
		'pauseStreamObservability',
		'pauseDiagnosticDelivery',
		'stopClientTracing',
		'gate:invalidate',
		'logDebug',
		'handshake',
		'join',
		'logDebug',
		'startReconnectSnapshotEventBuffer',
		'snapshot',
		'disconnectInfo:cleared',
		'setErrorReportingUser',
		'configureDiagnosticDelivery',
		'setErrorReportingIdentity',
		'configureStreamObservability',
		'getStreamClientSessionId',
		'configureTraceBackend',
		'setPluginCommands',
		'flushReconnectSnapshotEventBuffer',
		'nonce',
		'timer:clear',
		'gate:authenticate',
		'markVoiceReconnectSessionAuthenticated',
		'authenticateStreamObservability',
		'authenticateDiagnosticDelivery',
		'recordVoiceDiagnostic',
		'getValidPendingVoiceReconnect',
	],
	'trace-drop-resume-voice': [
		'recordVoiceDiagnostic',
		'recordDesktopDiagnostic:websocket_closed',
		'gate:invalidate',
		'pauseStreamObservability',
		'pauseDiagnosticDelivery',
		'stopClientTracing',
		'markVoiceReconnectSessionUnauthenticated',
		'captureVoiceReconnectIntentForCurrentSession',
		'ensureVoiceReconnectStarted',
		'timer:arm:45000',
		'recordDesktopDiagnostic:websocket_opened:reconnecting=true',
		'pauseStreamObservability',
		'pauseDiagnosticDelivery',
		'stopClientTracing',
		'gate:invalidate',
		'logDebug',
		'handshake',
		'join',
		'logDebug',
		'startReconnectSnapshotEventBuffer',
		'snapshot',
		'disconnectInfo:cleared',
		'setErrorReportingUser',
		'configureDiagnosticDelivery',
		'setErrorReportingIdentity',
		'configureStreamObservability',
		'getStreamClientSessionId',
		'configureTraceBackend',
		'setPluginCommands',
		'flushReconnectSnapshotEventBuffer',
		'nonce',
		'timer:clear',
		'gate:authenticate',
		'markVoiceReconnectSessionAuthenticated',
		'authenticateStreamObservability',
		'authenticateDiagnosticDelivery',
		'recordVoiceDiagnostic',
		'getValidPendingVoiceReconnect',
		'logDebug',
		'ensureVoiceReconnectStarted',
	],
	'trace-terminal-kicked': [
		'recordVoiceDiagnostic',
		'recordDesktopDiagnostic:websocket_closed',
		'gate:invalidate',
		'pauseStreamObservability',
		'pauseDiagnosticDelivery',
		'stopClientTracing',
		'clearVoiceReconnectRecovery:kicked',
		'clearStreamObservability',
		'clearDiagnosticDelivery',
		'stopClientTracing',
		'setErrorReportingIdentity',
		'gate:cancel',
		'close',
		'resetServerScreens',
		'reset',
		'setErrorReportingUser',
		'resetDialogs',
		'resetApp',
		'playSound',
		'disconnectInfo:4000',
	],
	'trace-terminal-banned': [
		'recordVoiceDiagnostic',
		'recordDesktopDiagnostic:websocket_closed',
		'gate:invalidate',
		'pauseStreamObservability',
		'pauseDiagnosticDelivery',
		'stopClientTracing',
		'clearVoiceReconnectRecovery:banned',
		'clearStreamObservability',
		'clearDiagnosticDelivery',
		'stopClientTracing',
		'setErrorReportingIdentity',
		'gate:cancel',
		'close',
		'resetServerScreens',
		'reset',
		'setErrorReportingUser',
		'resetDialogs',
		'resetApp',
		'playSound',
		'disconnectInfo:4001',
	],
	'trace-terminal-after-drop': [
		'recordVoiceDiagnostic',
		'recordDesktopDiagnostic:websocket_closed',
		'gate:invalidate',
		'pauseStreamObservability',
		'pauseDiagnosticDelivery',
		'stopClientTracing',
		'listener:remove:online',
		'clearVoiceReconnectRecovery:kicked',
		'clearStreamObservability',
		'clearDiagnosticDelivery',
		'stopClientTracing',
		'setErrorReportingIdentity',
		'gate:cancel',
		'timer:clear',
		'close',
		'resetServerScreens',
		'reset',
		'setErrorReportingUser',
		'resetDialogs',
		'resetApp',
		'playSound',
		'disconnectInfo:4000',
	],
	'trace-cleanup': [
		'clearStreamObservability',
		'clearDiagnosticDelivery',
		'stopClientTracing',
		'setErrorReportingIdentity',
		'gate:cancel',
		'close',
		'resetServerScreens',
		'reset',
		'setErrorReportingUser',
		'resetDialogs',
		'resetApp',
	],
	'trace-cleanup-pending': [
		'clearStreamObservability',
		'clearDiagnosticDelivery',
		'stopClientTracing',
		'setErrorReportingIdentity',
		'gate:cancel',
		'listener:remove:online',
		'timer:clear',
		'close',
		'resetServerScreens',
		'reset',
		'setErrorReportingUser',
		'resetDialogs',
		'resetApp',
	],
	'trace-replace': [
		'refresh',
		'logDebug',
		'close',
		'pauseStreamObservability',
		'pauseDiagnosticDelivery',
		'stopClientTracing',
		'gate:invalidate',
		'handshake',
		'logDebug',
		'clearReconnectSnapshotEventBuffer',
		'clearStreamObservability',
		'clearDiagnosticDelivery',
		'stopClientTracing',
		'setErrorReportingIdentity',
		'gate:cancel',
		'timer:clear',
		'close',
		'resetServerScreens',
		'reset',
		'setErrorReportingUser',
		'resetDialogs',
		'resetApp',
		'disconnectInfo:1006',
	],
	'trace-replace-pending': [
		'close',
		'pauseStreamObservability',
		'pauseDiagnosticDelivery',
		'stopClientTracing',
		'gate:invalidate',
	],
	'trace-grace-expiry': [
		'timer:fire',
		'clearStreamObservability',
		'clearDiagnosticDelivery',
		'stopClientTracing',
		'setErrorReportingIdentity',
		'gate:cancel',
		'close',
		'resetServerScreens',
		'reset',
		'setErrorReportingUser',
		'resetDialogs',
		'resetApp',
		'playSound',
		'disconnectInfo:1006',
	],
};
if (mode && newModes.includes(mode)) {
	type Socket = (typeof sockets)[number];
	const drop = (socket: Socket, code = 1006) => {
		socket.connection.ws.readyState = 3;
		socket.onClose({ code, reason: 'reason', wasClean: code !== 1006 });
	};
	const reopen = (socket: Socket) => {
		socket.connection.ws.readyState = 1;
		socket.onOpen();
	};
	const socketAt = (index: number) => {
		const socket = sockets[index];
		assert.ok(socket);
		return socket;
	};
	const deferredState = () => {
		drop(socketAt(0));
		online = false;
		reopen(socketAt(0));
	};
	const wait = () => trpc.waitForTRPCSessionAuthentication(new AbortController().signal);
	const pending = async (promise: Promise<void>) => {
		let settled = false;
		void promise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await tick();
		assert.equal(settled, false);
	};

	if (mode.startsWith('deadline-')) {
		const assertTornDown = (code: number) => {
			assert.equal(trpc.getTRPCClientIfInitialized(), null);
			assert.equal(disconnectInfo?.code, code);
			assert.equal(liveTimers().length, 0);
			assert.equal(listeners.size, 0);
			assert.ok(!trace.some((entry) => entry.startsWith('clearVoiceReconnectRecovery')));
		};
		const arm = async (code = 4013) => {
			await actions.connect();
			now = 1000;
			holdHandshake = true;
			capturing(() => drop(socketAt(sockets.length - 1), code));
		};
		await arm();
		let socket = socketAt(0);
		if (mode === 'deadline-budget') {
			assert.equal(trace.at(-1), 'timer:arm:45000');
			now = 11000;
			let start = trace.length;
			reopen(socket);
			assert.ok(!trace.slice(start).includes('timer:clear'));
			assert.equal(liveTimers().length, 1);
			capturing(() => drop(socket));
			assert.deepEqual(
				trace.slice(start).filter((entry) => entry.startsWith('timer:')),
				['timer:clear', 'timer:arm:35000'],
			);
			now = 21000;
			start = trace.length;
			trpc.reconnectTRPC('first');
			assert.ok(!trace.slice(start).includes('timer:clear'));
			assert.equal(liveTimers().length, 1);
			socket = socketAt(1);
			now = 31000;
			reopen(socket);
			capturing(() => drop(socket));
			assert.equal(trace.at(-1), 'timer:arm:15000');
			now = 45500;
			capturing(() => drop(socket));
			assert.equal(trace.at(-1), 'timer:arm:500');
			now = 46500;
			capturing(() => drop(socket));
			assert.equal(trace.at(-1), 'timer:arm:0');
			capturing(fireTimer);
			assertTornDown(1006);
		} else if (mode === 'deadline-offline-replace-authenticated') {
			reopen(socket);
			handshake.reject(new MockTRPCClientError('expired', { code: 'UNAUTHORIZED' }));
			await tick();
			online = false;
			now = 46000;
			capturing(fireTimer);
			assert.equal(listeners.size, 1);
			holdHandshake = false;
			refresh.resolve(true);
			await tick();
			assert.equal(liveTimers().length, 0);
			assert.equal(readConnectionState?.().phase.name, 'ready');
			now = 48000;
			online = true;
			const start = trace.length;
			capturing(fireOnline);
			assert.ok(trpc.getTRPCClientIfInitialized());
			assert.equal(disconnectInfo, undefined);
			assert.equal(readConnectionState?.().phase.name, 'ready');
			assert.ok(!trace.slice(start).includes('handshake'));
		} else if (mode.startsWith('deadline-offline-replace-')) {
			online = false;
			now = 46000;
			capturing(fireTimer);
			assert.equal(trace.at(-2), 'timer:arm:20000');
			assert.equal(listeners.size, 1);
			assert.deepEqual(readConnectionState?.().phase, { name: 'recovering', since: 1000 });
			now = 47000;
			const start = trace.length;
			trpc.reconnectTRPC('first');
			assert.ok(!trace.slice(start).includes('listener:remove:online'));
			assert.ok(!trace.slice(start).includes('timer:clear'));
			assert.equal(liveTimers().length, 1);
			assert.equal(listeners.size, 1);
			assert.deepEqual(readConnectionState?.().phase, { name: 'recovering', since: 1000 });
			socket = socketAt(1);
			if (mode === 'deadline-offline-replace-cleanup') {
				trpc.cleanup();
				assert.equal(liveTimers().length, 0);
				assert.equal(listeners.size, 0);
				const end = trace.length;
				online = true;
				capturing(fireOnline);
				assert.equal(trace.length, end);
			} else {
				if (mode.endsWith('-open')) {
					now = 47500;
					const before = trace.length;
					socket.onOpen();
					assert.ok(!trace.slice(before).some((entry) => entry.startsWith('listener:') || entry === 'handshake'));
				} else socket.connection.ws.readyState = 3;
				now = 48000;
				online = true;
				const before = trace.length;
				capturing(fireOnline);
				assertTornDown(4013);
				assert.ok(!trace.slice(before).some((entry) => ['timer:fire', 'handshake', 'join'].includes(entry)));
			}
		} else if (mode === 'deadline-lastdrop-isolation') {
			// Recover one session, then expire another, then defer a third offline.
			holdHandshake = false;
			reopen(socket);
			await tick();
			assert.equal(liveTimers().length, 0);
			capturing(() => drop(socket, 4002));
			capturing(fireTimer);
			assertTornDown(4002);
			await actions.connect();
			socket = socketAt(sockets.length - 1);
			holdHandshake = true;
			now = 1000;
			capturing(() => drop(socket, 4003));
			online = false;
			reopen(socket);
			now = 46000;
			capturing(fireTimer);
			online = true;
			capturing(fireOnline);
			assertTornDown(4003);
		} else if (mode.startsWith('deadline-offline')) {
			online = false;
			if (mode.endsWith('-open')) reopen(socket);
			now = 46000;
			capturing(fireTimer);
			assert.equal(liveTimers().length, 1);
			assert.equal(listeners.size, 1);
			assert.ok(trpc.getTRPCClientIfInitialized());
			online = true;
			now = 46500;
			const before = trace.length;
			if (mode === 'deadline-offline') capturing(fireTimer);
			else capturing(fireOnline);
			assertTornDown(4013);
			assert.ok(!trace.slice(before).includes('handshake'));
		} else if (mode === 'deadline-replacement') {
			reopen(socket);
			handshake.reject(new MockTRPCClientError('expired', { code: 'UNAUTHORIZED' }));
			await tick();
			handshake = deferred<{ hasPassword: boolean; handshakeHash: string }>();
			refresh.resolve(true);
			await tick();
			assert.equal(sockets.length, 2);
			assert.equal(liveTimers().length, 1);
			capturing(fireTimer);
			assertTornDown(4013);
		} else if (mode === 'deadline-wasconnected-false') {
			state.connected = false;
			capturing(() => drop(socket, 4014));
			const before = trace.length;
			capturing(fireTimer);
			assertTornDown(4014);
			assert.ok(!trace.slice(before).includes('playSound'));
		} else {
			if (mode === 'deadline-cleanup-clears') online = false;
			reopen(socket);
			assert.equal(liveTimers().length, 1);
			if (mode === 'deadline-stalled-join') {
				capturing(fireTimer);
				assertTornDown(4013);
			} else if (mode === 'deadline-cleanup-clears') {
				trpc.cleanup();
				assert.equal(liveTimers().length, 0);
				assert.equal(listeners.size, 0);
			} else {
				mustChangePassword = mode === 'deadline-must-change-password';
				if (mode === 'deadline-join-on-closing-socket') socket.connection.ws.readyState = 2;
				const before = trace.length;
				handshake.resolve({ hasPassword: false, handshakeHash: 'hash' });
				await tick();
				if (mode === 'deadline-join-on-closing-socket') {
					assert.equal(liveTimers().length, 1);
					capturing(fireTimer);
					assertTornDown(4013);
				} else {
					assert.equal(liveTimers().length, 0);
					assert.equal(trace.slice(before).filter((entry) => entry === 'timer:clear').length, 1);
					assert.ok(trpc.getTRPCClientIfInitialized());
					assert.equal(disconnectInfo, undefined);
				}
			}
		}
		process.exit(0);
	}
	let start = 0;
	if (mode === 'first-connect-drop' || mode === 'grace-rearm' || mode.startsWith('edge-c-')) {
		holdHandshake = true;
		const connecting = actions.connect();
		drop(socketAt(0));
		if (mode === 'first-connect-drop' || mode === 'grace-rearm') {
			if (mode === 'grace-rearm') {
				const before = trace.length;
				drop(socketAt(0));
				assert.deepEqual(
					trace.slice(before).filter((entry) => entry.startsWith('timer:')),
					['timer:clear', 'timer:arm:20000'],
				);
			}
			fireTimer();
			assert.equal(trpc.getTRPCClientIfInitialized(), null);
			assert.equal(disconnectInfo?.code, 1006);
		} else {
			online = false;
			reopen(socketAt(0));
			handshake.resolve({ hasPassword: false, handshakeHash: 'hash' });
			await connecting;
			assert.ok(trace.includes('gate:authenticate'));
			assert.equal(liveTimers().length, 0);
			assert.equal(listeners.size, 1);
			online = true;
			start = trace.length;
			if (mode === 'edge-c-online') {
				fireOnline();
				await tick();
				assert.ok(!trace.slice(start).includes('timer:clear'));
				assert.ok(trace.slice(start).includes('handshake'));
			} else {
				assert.equal(liveTimers().length, 0);
				assert.ok(trpc.getTRPCClientIfInitialized());
				assert.equal(disconnectInfo, undefined);
			}
		}
	} else {
		mustChangePassword = mode === 'must-change-password';
		captureVoice = mode === 'trace-drop-resume-voice';
		pendingVoice = captureVoice;
		await actions.connect();
		const socket = socketAt(0);
		start = mode === 'trace-connect' ? 0 : trace.length;
		if (mode === 'read-connection-state') {
			assert.equal(trpc.getServerConnectionState().phase.name, 'ready');
			let calls = 0;
			const unsubscribe = trpc.subscribeServerConnectionState(() => {
				calls += 1;
			});
			drop(socket, 4013);
			assert.equal(trpc.getServerConnectionState().phase.name, 'recovering');
			assert.equal(calls, 1);
			reopen(socket);
			await tick();
			assert.equal(trpc.getServerConnectionState().phase.name, 'ready');
			assert.equal(trpc.getServerConnectionState(), trpc.getServerConnectionState());
			drop(socket, 4013);
			const phase = trpc.getServerConnectionState().phase;
			assert.equal(phase.name, 'recovering');
			trpc.reconnectTRPC('first');
			assert.strictEqual(
				trpc.getServerConnectionState().phase,
				phase,
				'a client replacement keeps the same recovering phase',
			);
			const beforeUnsubscribe = calls;
			unsubscribe();
			drop(socketAt(1), 4013);
			assert.equal(calls, beforeUnsubscribe, 'unsubscribing stops listener calls');
		} else if (
			['trace-drop-resume', 'trace-drop-resume-voice', 'must-change-password', 'gate-readystate'].includes(mode)
		) {
			let waiting: Promise<void> | undefined;
			if (mode === 'gate-readystate') {
				socket.connection.ws.readyState = 3;
				const before = trace.length;
				waiting = wait();
				await pending(waiting);
				assert.deepEqual(trace.slice(before), ['gate:invalidate']);
			}
			drop(socket, 4013);
			reopen(socket);
			await tick();
			if (waiting) await waiting;
			if (mustChangePassword) {
				assert.ok(!trace.includes('gate:authenticate'));
				assert.ok(!trace.includes('markVoiceReconnectSessionAuthenticated'));
				assert.equal(trace.filter((item) => item === 'handshake').length, 2);
			}
		} else if (mode.startsWith('trace-terminal-')) {
			if (mode === 'trace-terminal-after-drop') {
				deferredState();
				start = trace.length;
			}
			drop(socket, mode === 'trace-terminal-banned' ? DisconnectCode.BANNED : DisconnectCode.KICKED);
		} else if (mode === 'trace-cleanup' || mode === 'trace-cleanup-pending' || mode === 'trace-replace-pending') {
			if (mode !== 'trace-cleanup') {
				deferredState();
				start = trace.length;
			}
			if (mode === 'trace-replace-pending') trpc.reconnectTRPC('first');
			else trpc.cleanup();
		} else if (mode === 'trace-grace-expiry') {
			drop(socket);
			state.connected = false;
			start = trace.length;
			fireTimer();
			assert.equal(trpc.getTRPCClientIfInitialized(), null);
		} else if (mode === 'grace-offline') {
			drop(socket);
			online = false;
			start = trace.length;
			fireTimer();
			assert.deepEqual(trace.slice(start), ['timer:fire', 'timer:arm:20000', 'listener:add:online']);
			assert.ok(trpc.getTRPCClientIfInitialized());
			assert.equal(liveTimers().length, 1);
			online = true;
			fireTimer();
			assert.equal(trpc.getTRPCClientIfInitialized(), null);
		} else if (mode.startsWith('open-offline-') || mode === 'open-online-socket-closed') {
			deferredState();
			assert.equal(liveTimers().length, 1);
			assert.ok(trace.includes('listener:add:online'));
			assert.equal(trace.filter((item) => item === 'handshake').length, 1);
			online = true;
			start = trace.length;
			if (mode !== 'open-offline-defer') socket.connection.ws.readyState = 3;
			if (mode === 'open-online-socket-closed') socket.onOpen();
			else fireOnline();
			await tick();
			assert.ok(trace.slice(start).includes('listener:remove:online'));
			if (mode === 'open-offline-defer') {
				assert.ok(trace.slice(start).includes('timer:clear'));
				assert.ok(trace.slice(start).includes('handshake'));
				assert.ok(trace.slice(start).includes('snapshot'));
			} else {
				assert.ok(!trace.slice(start).includes('timer:clear'));
				assert.ok(!trace.slice(start).includes('handshake'));
				assert.equal(liveTimers().length, 1);
			}
		} else if (mode === 'open-without-drop') {
			socket.onOpen();
			assert.deepEqual(trace.slice(start), [
				'recordDesktopDiagnostic:websocket_opened:reconnecting=false',
				'pauseStreamObservability',
				'pauseDiagnosticDelivery',
				'stopClientTracing',
				'gate:invalidate',
			]);
			await pending(wait());
		} else if (mode === 'trace-replace' || mode === 'edge-b-replacement-drop') {
			holdHandshake = true;
			drop(socket, 4013);
			reopen(socket);
			handshake.reject(new MockTRPCClientError('expired', { code: 'UNAUTHORIZED' }));
			await tick();
			start = trace.indexOf('refresh');
			handshake = deferred<{ hasPassword: boolean; handshakeHash: string }>();
			refresh.resolve(true);
			await tick();
			if (mode === 'trace-replace') {
				handshake.reject(new Error('server unavailable'));
				await tick();
			} else {
				start = trace.length;
				drop(socketAt(1));
				reopen(socketAt(1));
				await tick();
				assert.ok(!trace.slice(start).includes('handshake'));
				assert.ok(!trace.slice(start).includes('logDebug'));
				assert.equal(liveTimers().length, 1);
				assert.ok(trpc.getTRPCClientIfInitialized());
			}
		} else if (mode === 'gate') {
			await wait();
			drop(socket);
			const resumed = wait();
			await pending(resumed);
			reopen(socket);
			await tick();
			await resumed;
			drop(socket);
			const replaced = wait();
			trpc.reconnectTRPC('different-host');
			await pending(replaced);
			await actions.connect();
			await replaced;
			drop(socketAt(sockets.length - 1));
			const cancelled = wait();
			const rejected = assert.rejects(cancelled, trpc.TRPCClientUnavailableError);
			trpc.cleanup();
			await rejected;
			await assert.rejects(wait(), trpc.TRPCClientUnavailableError);
			await actions.connect();
			const controller = new AbortController();
			const reason = new Error('aborted');
			controller.abort(reason);
			await assert.rejects(trpc.waitForTRPCSessionAuthentication(controller.signal), (error) => error === reason);
		}
	}
	if (mode.startsWith('trace-')) {
		assert.deepEqual(trace.slice(start), literalTraces[mode]);
	}
	process.exit(0);
}
if (mode === 'initial-reopen' || mode === 'close-refresh') {
	holdHandshake = true;
	const connecting = actions.connect();
	const socket = sockets[0];
	assert.ok(socket);
	if (mode === 'initial-reopen') {
		socket.onClose({ code: 1006, wasClean: false });
		socket.onOpen();
		handshake.resolve({ hasPassword: false, handshakeHash: 'reopened' });
	} else {
		// tRPC rejects pending work before calling onClose in the same listener.
		handshake.reject(new Error('WebSocket closed'));
		socket.onClose({ code: 1006, wasClean: false });
		await tick();
		assert.ok(effects.includes('refresh'), 'close-rejected handshake must refresh tokens');
		holdHandshake = false;
		refresh.resolve(true);
	}
	await connecting;
	assert.ok(effects.includes('snapshot'), 'initial connect must apply snapshot');
	assert.equal(state.connecting, false, 'initial connect must reset loading');
	trpc.cleanup();
	process.exit(0);
}
await actions.connect();
const oldSocket = sockets[0];
assert.ok(oldSocket);
if (mode?.startsWith('rejoin-')) {
	holdHandshake = true;
	oldSocket.onClose({ code: 4013, wasClean: true });
	oldSocket.onOpen();
	if (mode === 'rejoin-failure') handshake.reject(new Error('server unavailable'));
	else if (mode === 'rejoin-client-error')
		handshake.reject(new MockTRPCClientError('bad request', { code: 'BAD_REQUEST' }));
	else if (mode === 'rejoin-forbidden') handshake.reject(new MockTRPCClientError('banned', { code: 'FORBIDDEN' }));
	else {
		handshake.reject(new MockTRPCClientError('expired', { code: 'UNAUTHORIZED' }));
		await tick();
		if (mode === 'rejoin-refresh-rejected' || mode === 'rejoin-refresh-offline') {
			hasAuth = mode === 'rejoin-refresh-offline';
			refresh.resolve(false);
		} else {
			handshake = deferred<{ hasPassword: boolean; handshakeHash: string }>();
			refresh.resolve(true);
			await tick();
			if (mode === 'rejoin-password') handshake.resolve({ hasPassword: true, handshakeHash: 'password' });
			else
				handshake.reject(
					mode === 'rejoin-auth-failure'
						? new MockTRPCClientError('revoked', { code: 'UNAUTHORIZED' })
						: mode === 'rejoin-untyped-transport'
							? new MockTRPCClientError('WebSocket closed')
							: new Error('server unavailable'),
				);
		}
	}
	await tick();
	assert.equal(trpc.getTRPCClientIfInitialized(), null, 'final failure must tear down');
	if (
		[
			'rejoin-failure',
			'rejoin-client-error',
			'rejoin-retry-failure',
			'rejoin-untyped-transport',
			'rejoin-refresh-offline',
		].includes(mode)
	) {
		assert.equal(
			disconnectInfo?.code,
			DisconnectCode.UNEXPECTED,
			'recoverable final rejoin must show disconnect screen',
		);
		assert.equal(disconnectInfo.wasClean, false);
		assert.ok(disconnectInfo.time instanceof Date);
		assert.equal(hasAuth, true, 'recoverable teardown must preserve credentials');
		assert.ok(
			!effects.includes('clearVoiceReconnectRecovery'),
			'recoverable teardown must keep voice recovery for the next join',
		);
	} else {
		assert.equal(disconnectInfo, undefined, 'auth/password exits must keep connect screen');
		// The password-required exit returns early without touching voice recovery,
		// unchanged from main.
		if (mode !== 'rejoin-password') {
			assert.ok(effects.includes('clearVoiceReconnectRecovery'), 'terminal exits must drop voice recovery');
		}
	}
} else if (mode === 'kicked' || mode === 'banned') {
	const code = mode === 'kicked' ? DisconnectCode.KICKED : DisconnectCode.BANNED;
	oldSocket.onClose({ code, reason: 'moderation reason', wasClean: true });
	assert.equal(trpc.getTRPCClientIfInitialized(), null);
	assert.equal(disconnectInfo?.code, code);
	assert.equal(disconnectInfo.reason, 'moderation reason');
	assert.equal(disconnectInfo.wasClean, true);
	assert.ok(effects.includes('clearVoiceReconnectRecovery'));
} else if (mode === 'logout') {
	await actions.logoutFromServer();
	assert.equal(disconnectInfo, undefined);
	assert.equal(hasAuth, false);
} else if (mode === 'refresh-replacement-drop') {
	holdHandshake = true;
	oldSocket.onClose({ code: 4013, wasClean: true });
	oldSocket.onOpen();
	handshake.reject(new MockTRPCClientError('expired token'));
	await tick();
	assert.ok(effects.includes('refresh'), 'silent rejoin must reach refresh');
	handshake = deferred<{ hasPassword: boolean; handshakeHash: string }>();
	refresh.resolve(true);
	await tick();
	const replacement = sockets[1];
	assert.ok(replacement);
	const before = effects.length;
	handshake.reject(new Error('WebSocket closed'));
	replacement.onClose({ code: 1006, wasClean: false });
	replacement.onOpen();
	await tick();
	assert.equal(trpc.getTRPCClientIfInitialized(), null, 'failed replacement must tear down rather than strand');
	assert.ok(effects.slice(before).includes('reset'), 'teardown must reset server state for disconnect screen');
	assert.equal(disconnectInfo?.code, DisconnectCode.UNEXPECTED, 'failed replacement must show disconnect screen');
	assert.ok(
		!effects.slice(before).includes('clearVoiceReconnectRecovery'),
		'disconnect-screen teardown must keep voice recovery',
	);
} else if (mode === 'connect-failure' || mode === 'connect-refresh') {
	trpc.cleanup();
	holdHandshake = true;
	const oldConnect = actions.connect();
	if (mode === 'connect-refresh') {
		handshake.reject(new Error('refreshable'));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	trpc.connectToTRPC('replacement');
	holdHandshake = false;
	await actions.connect();
	const before = [...effects];
	if (mode === 'connect-refresh') refresh.resolve(true);
	else handshake.reject(new trpc.TRPCClientUnavailableError());
	await oldConnect;
	assert.deepEqual(effects, before, 'obsolete connect catch/finally must be inert');
} else {
	holdJoin = mode !== 'handshake-success';
	holdHandshake = mode === 'handshake-success';
	// Trigger the registered rejoin without waiting for a real timer/network.
	oldSocket.onClose({ code: 4013, wasClean: true });
	oldSocket.onOpen();
	await new Promise((resolve) => setTimeout(resolve, 0));
	const closes = effects.filter((effect) => effect === 'close').length;
	trpc.connectToTRPC('replacement');
	assert.equal(
		effects.filter((effect) => effect === 'close').length,
		closes + 1,
		'host replacement retires previous client',
	);
	holdJoin = false;
	holdHandshake = false;
	await actions.connect();
	const before = [...effects];
	if (mode === 'handshake-success') handshake.resolve({ hasPassword: false, handshakeHash: 'old' });
	else if (mode === 'success') join.resolve({ mustChangePassword: false, commands: {} });
	else join.reject(new trpc.TRPCClientUnavailableError());
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(effects, before, 'retired rejoin success/failure must not mutate replacement');
	oldSocket.onOpen();
	oldSocket.onClose({ code: 4013 });
	assert.deepEqual(
		effects.slice(before.length),
		['close', 'raw-close'],
		'retired callbacks only close their own socket',
	);
}
trpc.cleanup();
