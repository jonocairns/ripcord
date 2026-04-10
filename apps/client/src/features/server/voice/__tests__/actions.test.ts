import { ChannelType, type TChannel } from '@sharkord/shared';
import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SoundType } from '../../types';
import { useServerStore } from '../../slice';
import { ownVoiceStateSelector } from '../selectors';

let removeUserFromVoiceChannel: typeof import('../actions').removeUserFromVoiceChannel;
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

		({ removeUserFromVoiceChannel } = await import('../actions'));
	});

	beforeEach(() => {
		useServerStore.getState().resetState();
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
});
