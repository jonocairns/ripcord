import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';
import { DisconnectCode } from '@sharkord/shared/src/statics';
import { configureAppCore } from './adapters';
import {
	clearPendingVoiceReconnectChannelId,
	getPendingVoiceReconnectChannelId,
	setPendingVoiceReconnectChannelId,
} from './reconnect-state';
import { useServerStore } from './server-store';
import { createServerInfo } from './test-fixtures';

type TSocketCloseEvent = {
	code: number;
	currentTarget?: EventTarget | null;
	reason: string;
	target?: EventTarget | null;
	wasClean: boolean;
};

type TWsOptions = {
	connectionParams: () => Promise<{ token: string }>;
	onClose: (cause: TSocketCloseEvent) => void;
	onOpen: () => void;
	url: string;
};

class MockTRPCClientError extends Error {
	data?: { code?: string };
}

const mockSocket = new EventTarget();
const closeClientMock = mock(() => {});
let wsOptions: TWsOptions | undefined;

mock.module('@trpc/client', () => ({
	TRPCClientError: MockTRPCClientError,
	createTRPCProxyClient: mock(() => ({ mocked: true })),
	createWSClient: mock((options: TWsOptions) => {
		wsOptions = options;

		return {
			close: closeClientMock,
			connection: { ws: mockSocket },
		};
	}),
	wsLink: mock(() => ({ mockedLink: true })),
}));

const { cleanup, connectToTRPC, setOnWsReconnect } = await import('./trpc');

describe('trpc reconnect handling', () => {
	const onReset = mock(() => {});
	const onServerDisconnected = mock(() => {});

	beforeEach(() => {
		vi.useRealTimers();
		wsOptions = undefined;
		closeClientMock.mockClear();
		configureAppCore({
			effects: {
				onReset,
				onServerDisconnected,
			},
			serverConfig: {
				getServerHost: () => 'example.test/trpc',
				getServerProtocol: () => 'https:',
				getServerUrl: () => 'https://example.test',
			},
			storage: {
				clearAuthToken: () => {},
				getAuthToken: () => 'token',
				getRefreshToken: () => 'refresh-token',
				setAuthTokens: () => {},
			},
		});
		clearPendingVoiceReconnectChannelId();
		setOnWsReconnect(null);
		cleanup({ ignoreSocketCloseEvent: true });
		onReset.mockClear();
		onServerDisconnected.mockClear();
		useServerStore.setState(useServerStore.getInitialState(), true);
	});

	test('preserves an existing pending voice reconnect channel when live voice state is already cleared', () => {
		useServerStore.getState().setConnected(true);
		setPendingVoiceReconnectChannelId(91);

		connectToTRPC('example.test/trpc');

		wsOptions?.onClose({
			code: DisconnectCode.UNEXPECTED,
			reason: 'socket dropped',
			wasClean: false,
		});

		expect(getPendingVoiceReconnectChannelId()).toBe(91);
	});

	test('applies disconnect cleanup after the retry grace period expires', () => {
		vi.useFakeTimers();
		useServerStore.getState().setInfo(createServerInfo());
		useServerStore.getState().setConnected(true);
		useServerStore.getState().setCurrentVoiceChannelId(42);

		connectToTRPC('example.test/trpc');

		wsOptions?.onClose({
			code: DisconnectCode.UNEXPECTED,
			reason: 'network lost',
			wasClean: false,
		});

		expect(useServerStore.getState().connected).toBeTrue();
		expect(getPendingVoiceReconnectChannelId()).toBe(42);

		vi.advanceTimersByTime(5_000);

		const state = useServerStore.getState();

		expect(state.connected).toBeFalse();
		expect(state.currentVoiceChannelId).toBeUndefined();
		expect(state.disconnectInfo?.code).toBe(DisconnectCode.UNEXPECTED);
		expect(state.disconnectInfo?.reason).toBe('network lost');
		expect(onReset).toHaveBeenCalledTimes(1);
		expect(onServerDisconnected).toHaveBeenCalledTimes(1);
	});

	test('cancels pending teardown when the websocket reconnects in time', () => {
		vi.useFakeTimers();
		const onReconnect = mock(() => {});

		useServerStore.getState().setConnected(true);
		connectToTRPC('example.test/trpc');
		setOnWsReconnect(onReconnect);

		wsOptions?.onClose({
			code: DisconnectCode.UNEXPECTED,
			reason: 'temporary blip',
			wasClean: false,
		});
		wsOptions?.onOpen();
		vi.advanceTimersByTime(5_000);

		expect(onReconnect).toHaveBeenCalledTimes(1);
		expect(useServerStore.getState().disconnectInfo).toBeUndefined();
		expect(onReset).not.toHaveBeenCalled();
		expect(onServerDisconnected).not.toHaveBeenCalled();
	});
});
