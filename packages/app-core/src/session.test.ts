import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { clearPendingVoiceReconnectChannelId } from './reconnect-state';
import { useServerStore } from './server-store';
import { createInitialServerData } from './test-fixtures';

type THandshakeResponse = {
	handshakeHash: string;
	hasPassword: boolean;
};

const flushMicrotasks = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

const createDeferred = <T>() => {
	let resolve: (value: T | PromiseLike<T>) => void = () => {};
	let reject: (reason?: unknown) => void = () => {};

	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});

	return { promise, reject, resolve };
};

let reconnectCallback: (() => void) | null = null;
let joinServerCalls = 0;
let joinServerImpl = async () => createInitialServerData();
let handshakeImpl = async (): Promise<THandshakeResponse> => ({
	handshakeHash: 'handshake-1',
	hasPassword: false,
});

const joinServerQuery = mock(() => {
	joinServerCalls += 1;
	return joinServerImpl();
});

const handshakeQuery = mock(() => handshakeImpl());
const initSubscriptionsMock = mock(() => () => {});
const setPluginCommandsMock = mock(() => {});
const cleanupMock = mock(() => {});
const connectToTRPCMock = mock(() => mockedTrpcClient);
const getTRPCClientMock = mock(() => mockedTrpcClient);
const reconnectTRPCMock = mock(() => mockedTrpcClient);
const setOnWsReconnectMock = mock((callback: (() => void) | null) => {
	reconnectCallback = callback;
});

const mockedTrpcClient = {
	others: {
		handshake: {
			query: handshakeQuery,
		},
		joinServer: {
			query: joinServerQuery,
		},
	},
};

class MockTRPCClientError extends Error {
	data?: { code?: string };
}

mock.module('@trpc/client', () => ({
	TRPCClientError: MockTRPCClientError,
}));

mock.module('./http', () => ({
	fetchServerInfo: mock(async () => undefined),
	refreshAccessToken: mock(async () => false),
	revokeRefreshToken: mock(async () => {}),
}));

mock.module('./subscriptions', () => ({
	initSubscriptions: initSubscriptionsMock,
	setPluginCommands: setPluginCommandsMock,
}));

mock.module('./trpc', () => ({
	cleanup: cleanupMock,
	connectToTRPC: connectToTRPCMock,
	getTRPCClient: getTRPCClientMock,
	reconnectTRPC: reconnectTRPCMock,
	setOnWsReconnect: setOnWsReconnectMock,
}));

const { disconnectFromServer, joinServer } = await import('./session');

describe('session reconnect flow', () => {
	beforeEach(() => {
		reconnectCallback = null;
		joinServerCalls = 0;
		joinServerImpl = async () => createInitialServerData();
		handshakeImpl = async () => ({
			handshakeHash: 'handshake-1',
			hasPassword: false,
		});
		joinServerQuery.mockClear();
		handshakeQuery.mockClear();
		initSubscriptionsMock.mockClear();
		setPluginCommandsMock.mockClear();
		cleanupMock.mockClear();
		connectToTRPCMock.mockClear();
		getTRPCClientMock.mockClear();
		reconnectTRPCMock.mockClear();
		setOnWsReconnectMock.mockClear();
		clearPendingVoiceReconnectChannelId();
		useServerStore.setState(useServerStore.getInitialState(), true);
	});

	test('clears the current voice channel only after silent rejoin succeeds', async () => {
		const initialData = createInitialServerData();
		const reconnectJoin = createDeferred<typeof initialData>();
		const typedTrpcClient = mockedTrpcClient as unknown as NonNullable<Parameters<typeof joinServer>[2]>;

		joinServerImpl = async () => {
			if (joinServerCalls === 1) {
				return initialData;
			}

			return reconnectJoin.promise;
		};

		await joinServer('initial-handshake', undefined, typedTrpcClient);
		useServerStore.getState().setCurrentVoiceChannelId(33);

		expect(reconnectCallback).not.toBeNull();

		reconnectCallback?.();
		await flushMicrotasks();

		expect(useServerStore.getState().currentVoiceChannelId).toBe(33);
		expect(handshakeQuery).toHaveBeenCalledTimes(1);

		reconnectJoin.resolve(initialData);
		await flushMicrotasks();

		expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();
		expect(joinServerQuery).toHaveBeenCalledTimes(2);
	});

	test('disconnectFromServer unregisters websocket reconnect handling', () => {
		reconnectCallback = () => {};

		disconnectFromServer();

		expect(setOnWsReconnectMock).toHaveBeenLastCalledWith(null);
	});
});
