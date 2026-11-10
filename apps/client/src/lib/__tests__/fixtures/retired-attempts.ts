import { mock } from 'bun:test';
import assert from 'node:assert/strict';

const effects: string[] = [];
const noop = () => {};
const record = (name: string) => () => {
	effects.push(name);
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
const state = {
	connected: true,
	connecting: false,
	resetState: record('reset'),
	setConnecting: (value: boolean) => {
		state.connecting = value;
		effects.push(`loading:${value}`);
	},
	setInitialData: record('snapshot'),
	setDisconnectInfo: noop,
	bumpServerRejoinNonce: record('nonce'),
};
const modules: Record<string, string[]> = {
	'@/features/app/actions': ['resetApp'],
	'@/features/dialogs/actions': ['resetDialogs', 'openDialog'],
	'@/features/server/disconnect-utils': ['shouldRestoreVoiceAfterDisconnect'],
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
mock.module('@/features/server/disconnect-utils', () => ({ shouldRestoreVoiceAfterDisconnect: () => true }));
mock.module('@/features/server/voice/reconnect-lab-debug', () => ({ isVoiceReconnectOnline: () => true }));
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
const refresh = deferred<boolean>();
mock.module('@/helpers/auth', () => ({
	refreshAccessToken: () => {
		effects.push('refresh');
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
class MockTRPCClientError extends Error {}
mock.module('@trpc/client', () => ({
	TRPCClientError: MockTRPCClientError,
	wsLink: noop,
	createWSClient: (options: { onOpen: () => void; onClose: (event: object) => void }) => {
		const socket = {
			...options,
			close: async () => {
				effects.push('close');
			},
			connection: { ws: { readyState: 1, close: record('raw-close') } },
		};
		sockets.push(socket);
		return socket;
	},
	createTRPCProxyClient: () => ({
		others: {
			handshake: {
				query: () =>
					holdHandshake ? handshake.promise : Promise.resolve({ hasPassword: false, handshakeHash: 'hash' }),
			},
			joinServer: {
				query: () => (holdJoin ? join.promise : Promise.resolve({ mustChangePassword: false, commands: {} })),
			},
		},
	}),
}));
// Browser/module-load dependencies are mocked explicitly; run in an isolated process.
Object.assign(globalThis, { window: {}, WebSocket: { OPEN: 1 } });
const trpc = await import('../../trpc');
const actions = await import('../../../features/server/actions');
const mode = process.argv[2];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
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
if (mode === 'refresh-replacement-drop') {
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
	assert.ok(effects.slice(before).includes('clearVoiceReconnectRecovery'));
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
