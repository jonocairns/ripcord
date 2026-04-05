import type { TInitialServerData } from '@/features/server/slice';
import { beforeEach, describe, expect, it } from 'bun:test';
import type { TVoiceUserState } from '@sharkord/shared';
import { useServerStore } from '../../slice';
import { ownConfirmedVoiceStateSelector } from '../selectors';

const createVoiceState = (overrides: Partial<TVoiceUserState> = {}): TVoiceUserState => ({
	micMuted: false,
	soundMuted: false,
	webcamEnabled: false,
	sharingScreen: false,
	...overrides,
});

describe('voice store own state sync', () => {
	beforeEach(() => {
		useServerStore.getState().resetState();
	});

	it('hydrates ownVoiceState from initial voice data when the own user is already in voice', () => {
		const initialVoiceState = createVoiceState({
			micMuted: true,
			soundMuted: true,
		});
		const data: TInitialServerData = {
			serverId: 'server-1',
			categories: [],
			channels: [],
			users: [],
			ownUserId: 42,
			mustChangePassword: false,
			roles: [],
			emojis: [],
			publicSettings: undefined,
			voiceMap: {
				7: {
					users: {
						42: initialVoiceState,
					},
				},
			},
			externalStreamsMap: {},
			channelPermissions: {},
			readStates: {},
		};

		useServerStore.getState().setInitialData(data);

		expect(useServerStore.getState().ownVoiceState).toEqual(initialVoiceState);
	});

	it('syncs ownVoiceState when the own user is added to a voice channel', () => {
		const joinedVoiceState = createVoiceState({
			micMuted: true,
			webcamEnabled: true,
		});

		useServerStore.setState({
			ownUserId: 42,
		});

		useServerStore.getState().addUserToVoiceChannel({
			channelId: 7,
			userId: 42,
			state: joinedVoiceState,
		});

		expect(useServerStore.getState().ownVoiceState).toEqual(joinedVoiceState);
	});

	it('syncs ownVoiceState and confirmed voice state when the own user receives a server update', () => {
		const initialVoiceState = createVoiceState();

		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			voiceMap: {
				7: {
					users: {
						42: initialVoiceState,
					},
				},
			},
			ownVoiceState: initialVoiceState,
		});

		useServerStore.getState().updateVoiceUserState({
			channelId: 7,
			userId: 42,
			newState: {
				micMuted: true,
				soundMuted: true,
			},
		});

		expect(useServerStore.getState().ownVoiceState).toEqual(
			createVoiceState({
				micMuted: true,
				soundMuted: true,
			}),
		);
		expect(ownConfirmedVoiceStateSelector(useServerStore.getState())).toEqual(
			createVoiceState({
				micMuted: true,
				soundMuted: true,
			}),
		);
	});
});
