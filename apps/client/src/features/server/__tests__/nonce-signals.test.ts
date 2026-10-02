import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { subscribeToFileListInvalidations } from '../nonce-signals';
import type { TInitialServerData } from '../slice';
import { useServerStore } from '../slice';

const createInitialData = (mustChangePassword: boolean): TInitialServerData => ({
	serverId: 'server',
	categories: [],
	channels: [],
	users: [],
	ownUserId: 1,
	mustChangePassword,
	roles: [],
	emojis: [],
	voiceMap: {},
	externalStreamsMap: {},
	channelPermissions: {},
	readStates: {},
});

describe('subscribeToFileListInvalidations', () => {
	beforeEach(() => {
		useServerStore.getState().resetState();
	});

	it('refetches after a confirmed rejoin', () => {
		const refetch = mock(() => {});
		const unsubscribe = subscribeToFileListInvalidations(refetch);

		useServerStore.getState().bumpServerRejoinNonce();
		unsubscribe();

		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it('refetches on CHANNEL_FILE_ACCESS_CHANGED', () => {
		const refetch = mock(() => {});
		const unsubscribe = subscribeToFileListInvalidations(refetch);

		useServerStore.getState().bumpFileAccessChangeNonce();
		unsubscribe();

		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it('ignores a raw socket reconnect, a mustChangePassword rejoin and a store reset', () => {
		useServerStore.getState().bumpServerRejoinNonce();

		const refetch = mock(() => {});
		const unsubscribe = subscribeToFileListInvalidations(refetch);
		const store = useServerStore.getState();

		store.setConnected(false);
		store.setConnecting(true);
		store.setConnected(true);
		store.setInitialData(createInitialData(true));
		store.resetState();
		unsubscribe();

		expect(refetch).not.toHaveBeenCalled();
	});

	it('stops after unsubscribing', () => {
		const refetch = mock(() => {});

		subscribeToFileListInvalidations(refetch)();
		useServerStore.getState().bumpServerRejoinNonce();

		expect(refetch).not.toHaveBeenCalled();
	});
});
