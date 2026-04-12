import type { TInitialServerData } from '@/features/server/slice';
import { beforeEach, describe, expect, it } from 'bun:test';
import type { TVoiceUserState } from '@sharkord/shared';
import { useServerStore } from '../../slice';
import { ownConfirmedVoiceStateSelector, ownVoiceStateSelector } from '../selectors';

const createVoiceState = (overrides: Partial<TVoiceUserState> = {}): TVoiceUserState => ({
	micMuted: false,
	soundMuted: false,
	webcamEnabled: false,
	sharingScreen: false,
	...overrides,
});

describe('voice store own state derivation', () => {
	beforeEach(() => {
		useServerStore.getState().resetState();
	});

	it('stores off-channel voice defaults from initial voice data', () => {
		const initialVoiceState = createVoiceState({
			micMuted: true,
			soundMuted: true,
			webcamEnabled: true,
			sharingScreen: true,
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

		expect(useServerStore.getState().ownVoiceDefaults).toEqual(
			createVoiceState({
				micMuted: true,
				soundMuted: true,
			}),
		);
	});

	it('returns undefined confirmed state and falls back to own defaults when not in voice', () => {
		const ownVoiceDefaults = createVoiceState({
			micMuted: true,
			soundMuted: true,
		});

		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: undefined,
			ownVoiceDefaults,
		});

		expect(ownConfirmedVoiceStateSelector(useServerStore.getState())).toBeUndefined();
		expect(ownVoiceStateSelector(useServerStore.getState())).toEqual(ownVoiceDefaults);
	});

	it('derives own voice state from the confirmed voice map when the own user is in voice', () => {
		const joinedVoiceState = createVoiceState({
			micMuted: true,
			webcamEnabled: true,
		});

		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			ownVoiceDefaults: createVoiceState({
				micMuted: false,
				webcamEnabled: false,
			}),
		});

		useServerStore.getState().addUserToVoiceChannel({
			channelId: 7,
			userId: 42,
			state: joinedVoiceState,
		});

		expect(ownVoiceStateSelector(useServerStore.getState())).toEqual(joinedVoiceState);
		expect(useServerStore.getState().ownVoiceDefaults).toEqual(
			createVoiceState({
				micMuted: true,
			}),
		);
	});

	it('optimistically updates the own-user voice map entry instead of a parallel live field', () => {
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
			ownVoiceDefaults: initialVoiceState,
		});

		useServerStore.getState().updateOwnVoiceState({
			micMuted: true,
			webcamEnabled: true,
		});

		expect(ownConfirmedVoiceStateSelector(useServerStore.getState())).toEqual(
			createVoiceState({
				micMuted: true,
				webcamEnabled: true,
			}),
		);
		expect(ownVoiceStateSelector(useServerStore.getState())).toEqual(
			createVoiceState({
				micMuted: true,
				webcamEnabled: true,
			}),
		);
		expect(useServerStore.getState().ownVoiceDefaults).toEqual(
			createVoiceState({
				micMuted: true,
			}),
		);
	});

	it('reconcileVoiceChannelUsers yields to server state when no optimistic update is pending', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			voiceMap: {
				7: {
					users: {
						42: createVoiceState({ micMuted: false }),
					},
				},
			},
			ownVoiceDefaults: createVoiceState(),
			ownOptimisticStateExpiresAt: undefined,
		});

		useServerStore.getState().reconcileVoiceChannelUsers({
			channelId: 7,
			users: [{ userId: 42, state: createVoiceState({ micMuted: true }) }],
		});

		expect(ownConfirmedVoiceStateSelector(useServerStore.getState())).toEqual(createVoiceState({ micMuted: true }));
	});

	it('reconcileVoiceChannelUsers preserves local state while an optimistic update is still pending', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			voiceMap: {
				7: {
					users: {
						42: createVoiceState({ micMuted: true }),
					},
				},
			},
			ownVoiceDefaults: createVoiceState({ micMuted: true }),
			ownOptimisticStateExpiresAt: Date.now() + 5_000,
		});

		useServerStore.getState().reconcileVoiceChannelUsers({
			channelId: 7,
			users: [{ userId: 42, state: createVoiceState({ micMuted: false }) }],
		});

		// Local optimistic state (micMuted: true) wins over the server snapshot.
		expect(ownConfirmedVoiceStateSelector(useServerStore.getState())).toEqual(createVoiceState({ micMuted: true }));
	});

	it('reconcileVoiceChannelUsers yields to server state when the optimistic TTL has expired', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			voiceMap: {
				7: {
					users: {
						42: createVoiceState({ micMuted: false }),
					},
				},
			},
			ownVoiceDefaults: createVoiceState(),
			ownOptimisticStateExpiresAt: Date.now() - 1,
		});

		useServerStore.getState().reconcileVoiceChannelUsers({
			channelId: 7,
			users: [{ userId: 42, state: createVoiceState({ micMuted: true }) }],
		});

		// TTL has lapsed — server's admin-muted state wins.
		expect(ownConfirmedVoiceStateSelector(useServerStore.getState())).toEqual(createVoiceState({ micMuted: true }));
		// Expired sentinel is cleared in the same set call.
		expect(useServerStore.getState().ownOptimisticStateExpiresAt).toBeUndefined();
	});

	it('updateVoiceUserState clears ownOptimisticStateExpiresAt for the own user', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			voiceMap: {
				7: {
					users: {
						42: createVoiceState(),
					},
				},
			},
			ownVoiceDefaults: createVoiceState(),
			ownOptimisticStateExpiresAt: Date.now() + 5_000,
		});

		useServerStore.getState().updateVoiceUserState({
			channelId: 7,
			userId: 42,
			newState: { micMuted: true },
		});

		expect(useServerStore.getState().ownOptimisticStateExpiresAt).toBeUndefined();
	});

	it('setInitialData clears ownOptimisticStateExpiresAt', () => {
		useServerStore.setState({
			ownOptimisticStateExpiresAt: Date.now() + 5_000,
			screenShareWatchers: {
				10: true,
			},
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
			voiceMap: {},
			externalStreamsMap: {},
			channelPermissions: {},
			readStates: {},
		};

		useServerStore.getState().setInitialData(data);

		expect(useServerStore.getState().ownOptimisticStateExpiresAt).toBeUndefined();
		expect(useServerStore.getState().screenShareWatchers).toEqual({});
	});

	it('keeps derived and confirmed own voice state aligned when the server updates the own user', () => {
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
			ownVoiceDefaults: initialVoiceState,
		});

		useServerStore.getState().updateVoiceUserState({
			channelId: 7,
			userId: 42,
			newState: {
				micMuted: true,
				soundMuted: true,
			},
		});

		expect(ownConfirmedVoiceStateSelector(useServerStore.getState())).toEqual(
			createVoiceState({
				micMuted: true,
				soundMuted: true,
			}),
		);
		expect(ownVoiceStateSelector(useServerStore.getState())).toEqual(
			createVoiceState({
				micMuted: true,
				soundMuted: true,
			}),
		);
		expect(useServerStore.getState().ownVoiceDefaults).toEqual(
			createVoiceState({
				micMuted: true,
				soundMuted: true,
			}),
		);
	});

	it('clears screen share watchers when the local own share state changes', () => {
		useServerStore.setState({
			screenShareWatchers: {
				10: true,
				11: true,
			},
		});

		useServerStore.getState().updateOwnVoiceState({
			sharingScreen: true,
		});

		expect(useServerStore.getState().screenShareWatchers).toEqual({});
	});

	it('clears screen share watchers when the server turns off the own user screen share', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			voiceMap: {
				7: {
					users: {
						42: createVoiceState({ sharingScreen: true }),
					},
				},
			},
			ownVoiceDefaults: createVoiceState(),
			screenShareWatchers: {
				10: true,
			},
		});

		useServerStore.getState().updateVoiceUserState({
			channelId: 7,
			userId: 42,
			newState: {
				sharingScreen: false,
			},
		});

		expect(useServerStore.getState().screenShareWatchers).toEqual({});
	});
});
