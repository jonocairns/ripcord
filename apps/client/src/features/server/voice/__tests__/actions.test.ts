import { ChannelType, type TChannel } from '@sharkord/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { useServerStore } from '../../slice';

let removeUserFromVoiceChannel: typeof import('../actions').removeUserFromVoiceChannel;

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

		({ removeUserFromVoiceChannel } = await import('../actions'));
	});

	beforeEach(() => {
		useServerStore.getState().resetState();
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
			ownVoiceState: {
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
		expect(state.ownVoiceState).toEqual({
			micMuted: false,
			soundMuted: false,
			webcamEnabled: false,
			sharingScreen: false,
		});
		expect(state.pinnedCard).toBeUndefined();
	});
});
