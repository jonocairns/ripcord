import { beforeEach, describe, expect, test } from 'bun:test';
import { PinnedCardType } from './types';
import { useServerStore } from './server-store';
import { createChannelPermissions, createInitialServerData, createServerInfo } from './test-fixtures';

describe('server-store', () => {
	beforeEach(() => {
		useServerStore.setState(useServerStore.getInitialState(), true);
	});

	test('resetState preserves loaded server info while clearing volatile session state', () => {
		const info = createServerInfo();
		const initialData = createInitialServerData({
			readStates: { 12: 4 },
			voiceMap: {
				44: {
					users: {
						1: {
							micMuted: true,
							soundMuted: false,
							webcamEnabled: true,
							sharingScreen: false,
						},
					},
				},
			},
		});

		useServerStore.getState().setInfo(info);
		useServerStore.getState().setInitialData(initialData);
		useServerStore.getState().setSelectedChannelId(12);
		useServerStore.getState().setCurrentVoiceChannelId(44);
		useServerStore.getState().updateOwnVoiceState({
			micMuted: true,
			sharingScreen: true,
		});
		useServerStore.getState().setPinnedCard({
			id: 'user-1',
			type: PinnedCardType.USER,
			userId: 1,
		});

		useServerStore.getState().resetState();

		const state = useServerStore.getState();

		expect(state.info).toEqual(info);
		expect(state.connected).toBeFalse();
		expect(state.connecting).toBeFalse();
		expect(state.selectedChannelId).toBeUndefined();
		expect(state.currentVoiceChannelId).toBeUndefined();
		expect(state.voiceMap).toEqual({});
		expect(state.readStatesMap).toEqual({});
		expect(state.ownVoiceState).toEqual({
			micMuted: false,
			soundMuted: false,
			webcamEnabled: false,
			sharingScreen: false,
		});
		expect(state.pinnedCard).toBeUndefined();
	});

	test('setInitialData hydrates the core server snapshot and marks the store connected', () => {
		const initialData = createInitialServerData({
			readStates: { 21: 7 },
			channelPermissions: {
				21: {
					channelId: 21,
					permissions: createChannelPermissions(),
				},
			},
			voiceMap: {
				9: {
					users: {
						1: {
							micMuted: false,
							soundMuted: true,
							webcamEnabled: false,
							sharingScreen: false,
						},
					},
				},
			},
		});

		useServerStore.getState().setInitialData(initialData);

		const state = useServerStore.getState();

		expect(state.connected).toBeTrue();
		expect(state.serverId).toBe(initialData.serverId);
		expect(state.users).toEqual(initialData.users);
		expect(state.voiceMap).toEqual(initialData.voiceMap);
		expect(state.channelPermissions).toEqual(initialData.channelPermissions);
		expect(state.readStatesMap).toEqual(initialData.readStates);
	});
});
