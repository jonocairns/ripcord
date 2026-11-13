import { beforeEach, describe, expect, it } from 'bun:test';
import type { TVoiceUserState } from '@sharkord/shared';
import type { TInitialServerData } from '@/features/server/slice';
import { useServerStore } from '../../slice';
import { ownVoiceStateSelector } from '../selectors';

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
		useServerStore.getState().setOwnVoiceIntent({ micMuted: false, soundMuted: false });
	});

	it('uses local audio intent and server video while returning stable snapshots', () => {
		useServerStore.setState({ ownUserId: 42, currentVoiceChannelId: 7 });
		useServerStore.getState().addUserToVoiceChannel({
			channelId: 7,
			userId: 42,
			state: createVoiceState({ micMuted: true, webcamEnabled: true }),
		});
		const state = useServerStore.getState();
		expect(ownVoiceStateSelector(state)).toEqual(createVoiceState({ webcamEnabled: true }));
		expect(ownVoiceStateSelector(state)).toBe(ownVoiceStateSelector(state));
		expect(state.ownVoiceIntent).toEqual({ micMuted: false, soundMuted: false });
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
			ownVoiceIntent: initialVoiceState,
		});

		useServerStore.getState().setOwnVoiceIntent({ micMuted: true });
		useServerStore.getState().updateOwnVoiceState({
			webcamEnabled: true,
		});

		expect(useServerStore.getState().voiceMap[7]?.users[42]).toEqual(
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
		expect(useServerStore.getState().ownVoiceIntent.micMuted).toBe(true);
	});

	it('reconcile keeps local audio when no video update is pending', () => {
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
			ownVoiceIntent: createVoiceState(),
			ownOptimisticStateExpiresAt: undefined,
		});

		useServerStore.getState().reconcileVoiceChannelUsers({
			channelId: 7,
			users: [{ userId: 42, state: createVoiceState({ micMuted: true }) }],
		});

		expect(useServerStore.getState().voiceMap[7]?.users[42]?.micMuted).toBe(
			useServerStore.getState().ownVoiceIntent.micMuted,
		);
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
			ownVoiceIntent: createVoiceState({ micMuted: true }),
			ownOptimisticStateExpiresAt: Date.now() + 5_000,
		});

		useServerStore.getState().reconcileVoiceChannelUsers({
			channelId: 7,
			users: [{ userId: 42, state: createVoiceState({ micMuted: false }) }],
		});

		// Local optimistic state (micMuted: true) wins over the server snapshot.
		expect(useServerStore.getState().voiceMap[7]?.users[42]?.micMuted).toBe(
			useServerStore.getState().ownVoiceIntent.micMuted,
		);
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
			ownVoiceIntent: createVoiceState(),
			ownOptimisticStateExpiresAt: Date.now() - 1,
		});

		useServerStore.getState().reconcileVoiceChannelUsers({
			channelId: 7,
			users: [{ userId: 42, state: createVoiceState({ micMuted: true }) }],
		});

		// Audio remains client-owned after the video window expires.
		expect(useServerStore.getState().voiceMap[7]?.users[42]?.micMuted).toBe(
			useServerStore.getState().ownVoiceIntent.micMuted,
		);
		// Expired sentinel is cleared in the same set call.
		expect(useServerStore.getState().ownOptimisticStateExpiresAt).toBeUndefined();
	});

	it('updateVoiceUserState clears ownOptimisticStateExpiresAt for a matching own-user confirmation', () => {
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
			ownVoiceIntent: createVoiceState(),
			ownOptimisticStateExpiresAt: Date.now() + 5_000,
		});

		useServerStore.getState().updateVoiceUserState({
			channelId: 7,
			userId: 42,
			newState: { micMuted: true },
		});

		expect(useServerStore.getState().ownOptimisticStateExpiresAt).toBeUndefined();
	});

	it('updateVoiceUserState preserves newer own optimistic state over stale server confirmation', () => {
		const optimisticExpiresAt = Date.now() + 5_000;

		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			voiceMap: {
				7: {
					users: {
						42: createVoiceState({ webcamEnabled: true }),
					},
				},
			},
			ownVoiceIntent: createVoiceState({ webcamEnabled: true }),
			ownOptimisticStateExpiresAt: optimisticExpiresAt,
		});

		useServerStore.getState().updateVoiceUserState({
			channelId: 7,
			userId: 42,
			newState: { webcamEnabled: false },
		});

		expect(useServerStore.getState().voiceMap[7]?.users[42]?.webcamEnabled).toBe(true);
		expect(useServerStore.getState().ownOptimisticStateExpiresAt).toBe(optimisticExpiresAt);
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

	it('overlays audio intent on server updates', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			voiceMap: { 7: { users: { 42: createVoiceState() } } },
		});
		useServerStore
			.getState()
			.updateVoiceUserState({ channelId: 7, userId: 42, newState: { micMuted: true, soundMuted: true } });
		expect(ownVoiceStateSelector(useServerStore.getState())).toEqual(createVoiceState());
	});

	it('clears screen share watchers when the local own share stops but not when it is restated', () => {
		useServerStore.setState({
			screenShareWatchers: {
				10: true,
				11: true,
			},
		});

		useServerStore.getState().updateOwnVoiceState({
			sharingScreen: true,
		});

		expect(useServerStore.getState().screenShareWatchers).toEqual({ 10: true, 11: true });

		useServerStore.getState().updateOwnVoiceState({
			sharingScreen: false,
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
			ownVoiceIntent: createVoiceState(),
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
