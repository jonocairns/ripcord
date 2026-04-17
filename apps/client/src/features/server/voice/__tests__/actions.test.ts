import { ChannelType, StreamKind, type TChannel } from '@sharkord/shared';
import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SoundType } from '../../types';
import { useServerStore } from '../../slice';
import { useVoiceReconnectStore } from '../reconnect-coordinator';
import { ownVoiceStateSelector } from '../selectors';

let removeUserFromVoiceChannel: typeof import('../actions').removeUserFromVoiceChannel;
let handleStreamWatcherActivity: typeof import('../actions').handleStreamWatcherActivity;
let addUserToVoiceChannel: typeof import('../actions').addUserToVoiceChannel;
let updateVoiceUserState: typeof import('../actions').updateVoiceUserState;
const playSound = mock(() => {});

type TPinnedCardState = NonNullable<ReturnType<typeof useServerStore.getState>['pinnedCard']>;

const createChannel = (id: number, type: ChannelType): TChannel =>
	({
		id,
		type,
	}) as unknown as TChannel;

class MockAudioParam {
	setValueAtTime() {}
	exponentialRampToValueAtTime() {}
}

class MockAudioNode {
	connect() {
		return this;
	}
}

class MockGainNode extends MockAudioNode {
	gain = new MockAudioParam();
}

class MockDynamicsCompressorNode extends MockAudioNode {
	threshold = new MockAudioParam();
	knee = new MockAudioParam();
	ratio = new MockAudioParam();
	attack = new MockAudioParam();
	release = new MockAudioParam();
}

class MockOscillatorNode extends MockAudioNode {
	type: OscillatorType = 'sine';
	frequency = new MockAudioParam();
	start() {}
	stop() {}
}

class MockAudioContext {
	currentTime = 0;
	destination = new MockAudioNode();

	createGain() {
		return new MockGainNode();
	}

	createDynamicsCompressor() {
		return new MockDynamicsCompressorNode();
	}

	createOscillator() {
		return new MockOscillatorNode();
	}
}

describe('voice actions', () => {
	beforeAll(async () => {
		Object.assign(globalThis, {
			window: {
				AudioContext: MockAudioContext,
			},
		});

		mock.module('../../sounds/actions', () => ({
			playSound,
		}));

		({ addUserToVoiceChannel, removeUserFromVoiceChannel, handleStreamWatcherActivity, updateVoiceUserState } =
			await import('../actions'));
	});

	beforeEach(() => {
		useServerStore.getState().resetState();
		useVoiceReconnectStore.getState().resetState();
		playSound.mockClear();
	});

	it('clears own active voice state when the server removes the current user from voice', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			selectedChannelId: 7,
			lastTextChannelId: 9,
			channels: [createChannel(7, ChannelType.VOICE), createChannel(9, ChannelType.TEXT)],
			voiceMap: {
				7: {
					users: {
						42: {
							micMuted: false,
							soundMuted: false,
							webcamEnabled: true,
							sharingScreen: true,
						},
					},
				},
			},
			ownVoiceDefaults: {
				micMuted: false,
				soundMuted: false,
				webcamEnabled: true,
				sharingScreen: true,
			},
			pinnedCard: {
				id: 'screen-share-42',
				type: 'screen-share',
				userId: 42,
			} as unknown as TPinnedCardState,
		});

		removeUserFromVoiceChannel(42, 7);

		const state = useServerStore.getState();

		expect(state.currentVoiceChannelId).toBeUndefined();
		expect(state.selectedChannelId).toBe(9);
		expect(state.voiceMap[7]?.users[42]).toBeUndefined();
		expect(state.ownVoiceDefaults).toEqual({
			micMuted: false,
			soundMuted: false,
			webcamEnabled: false,
			sharingScreen: false,
		});
		expect(ownVoiceStateSelector(state)).toEqual({
			micMuted: false,
			soundMuted: false,
			webcamEnabled: false,
			sharingScreen: false,
		});
		expect(state.pinnedCard).toBeUndefined();
		expect(playSound).toHaveBeenCalledWith(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
	});

	it('does not play the own leave sound for reconnect bookkeeping', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			selectedChannelId: 7,
			lastTextChannelId: 9,
			channels: [createChannel(7, ChannelType.VOICE), createChannel(9, ChannelType.TEXT)],
			voiceMap: {
				7: {
					users: {
						42: {
							micMuted: false,
							soundMuted: false,
							webcamEnabled: false,
							sharingScreen: false,
						},
					},
				},
			},
		});

		removeUserFromVoiceChannel(42, 7, { reconnecting: true });

		expect(playSound).not.toHaveBeenCalledWith(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
	});

	it('tracks screen share watchers by watcher id so duplicate events do not drift the badge count', () => {
		handleStreamWatcherActivity({
			watcherId: 10,
			action: 'joined',
			kind: StreamKind.SCREEN,
		});
		handleStreamWatcherActivity({
			watcherId: 10,
			action: 'joined',
			kind: StreamKind.SCREEN,
		});
		handleStreamWatcherActivity({
			watcherId: 11,
			action: 'joined',
			kind: StreamKind.SCREEN,
		});

		expect(useServerStore.getState().screenShareWatchers).toEqual({
			10: true,
			11: true,
		});

		handleStreamWatcherActivity({
			watcherId: 10,
			action: 'left',
			kind: StreamKind.SCREEN,
		});
		handleStreamWatcherActivity({
			watcherId: 10,
			action: 'left',
			kind: StreamKind.SCREEN,
		});

		expect(useServerStore.getState().screenShareWatchers).toEqual({
			11: true,
		});
	});

	it('ignores non-screen watcher activity for the screen share badge state', () => {
		handleStreamWatcherActivity({
			watcherId: 10,
			action: 'joined',
			kind: StreamKind.VIDEO,
		});

		expect(useServerStore.getState().screenShareWatchers).toEqual({});
	});

	it('snapshots reconnect intent before clearing own voice state when reconnecting', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			selectedChannelId: 7,
			lastTextChannelId: 9,
			channels: [createChannel(7, ChannelType.VOICE), createChannel(9, ChannelType.TEXT)],
			ownVoiceDefaults: {
				micMuted: true,
				soundMuted: false,
				webcamEnabled: false,
				sharingScreen: false,
			},
			voiceMap: {
				7: {
					users: {
						42: { micMuted: true, soundMuted: false, webcamEnabled: false, sharingScreen: false },
						10: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
					},
				},
			},
		});

		removeUserFromVoiceChannel(42, 7, { reconnecting: true });

		// Own voice channel should be cleared
		expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();

		// But reconnect intent should be preserved in the coordinator
		const { pendingVoiceReconnect } = useVoiceReconnectStore.getState();
		expect(pendingVoiceReconnect).toBeDefined();
		if (!pendingVoiceReconnect) return;
		expect(pendingVoiceReconnect.channelId).toBe(7);
		expect(pendingVoiceReconnect.micMuted).toBe(true);
		expect(pendingVoiceReconnect.soundMuted).toBe(false);
		expect(pendingVoiceReconnect.peerUserIds).toEqual([10]);
	});

	it('does not snapshot reconnect intent when leaving without reconnecting', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			selectedChannelId: 7,
			lastTextChannelId: 9,
			channels: [createChannel(7, ChannelType.VOICE), createChannel(9, ChannelType.TEXT)],
			voiceMap: {
				7: {
					users: {
						42: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
					},
				},
			},
		});

		removeUserFromVoiceChannel(42, 7);

		expect(useVoiceReconnectStore.getState().pendingVoiceReconnect).toBeUndefined();
	});

	it('suppresses remote join sounds for peers captured in reconnect suppression', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
		});
		useVoiceReconnectStore.getState().setVoiceReconnectSuppression({
			channelId: 7,
			peerUserIds: [10],
			expiresAt: Date.now() + 10_000,
		});

		addUserToVoiceChannel(10, 7, {
			micMuted: false,
			soundMuted: false,
			webcamEnabled: false,
			sharingScreen: false,
		});

		expect(playSound).not.toHaveBeenCalledWith(SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL);
	});

	it('still plays remote join sounds for new peers outside reconnect suppression', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
		});
		useVoiceReconnectStore.getState().setVoiceReconnectSuppression({
			channelId: 7,
			peerUserIds: [10],
			expiresAt: Date.now() + 10_000,
		});

		addUserToVoiceChannel(11, 7, {
			micMuted: false,
			soundMuted: false,
			webcamEnabled: false,
			sharingScreen: false,
		});

		expect(playSound).toHaveBeenCalledWith(SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL);
	});

	it('suppresses started-stream sounds for peers captured in reconnect suppression', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			voiceMap: {
				7: {
					users: {
						10: {
							micMuted: false,
							soundMuted: false,
							webcamEnabled: false,
							sharingScreen: false,
						},
					},
				},
			},
		});
		useVoiceReconnectStore.getState().setVoiceReconnectSuppression({
			channelId: 7,
			peerUserIds: [10],
			expiresAt: Date.now() + 10_000,
		});

		updateVoiceUserState(10, 7, {
			webcamEnabled: true,
		});

		expect(playSound).not.toHaveBeenCalledWith(SoundType.REMOTE_USER_STARTED_STREAM);
	});
});
