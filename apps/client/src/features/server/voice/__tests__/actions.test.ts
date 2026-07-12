import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { ChannelType, StreamKind, type TChannel } from '@sharkord/shared';
import { useServerStore } from '../../slice';
import { SoundType } from '../../types';
import { useVoiceReconnectStore } from '../reconnect-coordinator';
import { ownVoiceStateSelector } from '../selectors';

let removeUserFromVoiceChannel: typeof import('../actions').removeUserFromVoiceChannel;
let handleStreamWatcherActivity: typeof import('../actions').handleStreamWatcherActivity;
let addUserToVoiceChannel: typeof import('../actions').addUserToVoiceChannel;
let updateVoiceUserState: typeof import('../actions').updateVoiceUserState;
let clearOwnVoiceSessionAfterReconnectFailure: typeof import('../actions').clearOwnVoiceSessionAfterReconnectFailure;
let leaveVoiceSessionAfterRecoveryFailure: typeof import('../actions').leaveVoiceSessionAfterRecoveryFailure;
let sendOwnVoiceStateUpdate: typeof import('../actions').sendOwnVoiceStateUpdate;
let flushVoiceForDesktopQuit: typeof import('../actions').flushVoiceForDesktopQuit;
let leaveVoice: typeof import('../actions').leaveVoice;
let joinVoice: typeof import('../actions').joinVoice;
let handleVoiceSessionReplaced: typeof import('../actions').handleVoiceSessionReplaced;
let resetVoiceSwitchStateForTests: typeof import('../actions').__resetVoiceSwitchStateForTests;
const playSound = mock(() => {});
const runVoiceProviderCleanup = mock(() => {});
let leaveShouldFail = false;
let joinShouldFail = false;
let joinHangsUntilAborted = false;
let beforeJoinResolve: (() => void) | undefined;
let waitBeforeLeaveResolve: Promise<void> | undefined;
const joinMutate = mock(async (_input?: unknown, opts?: { signal?: AbortSignal }) => {
	if (joinHangsUntilAborted) {
		await new Promise<never>((_resolve, reject) => {
			const signal = opts?.signal;

			if (!signal) {
				return;
			}

			if (signal.aborted) {
				reject(new Error('join aborted'));
				return;
			}

			signal.addEventListener('abort', () => {
				reject(new Error('join aborted'));
			});
		});
	}

	if (joinShouldFail) {
		throw new Error('join failed');
	}

	beforeJoinResolve?.();

	return {
		routerRtpCapabilities: {},
		producerTransportParams: undefined,
		consumerTransportParams: undefined,
		existingProducers: undefined,
		channelUsers: [],
	};
});
const leaveMutate = mock(async () => {
	await waitBeforeLeaveResolve;
	if (leaveShouldFail) {
		throw new Error('leave failed');
	}
});
let waitBeforeUpdateStateResolve: Promise<void> | undefined;
const updateStateMutate = mock(async (_input?: unknown) => {
	await waitBeforeUpdateStateResolve;
});

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

const setJoinedVoiceChannelState = (state: Partial<ReturnType<typeof useServerStore.getState>> = {}): void => {
	useServerStore.setState({
		currentVoiceChannelId: 7,
		selectedChannelId: 7,
		lastTextChannelId: 9,
		// The recovery-failure leave only fires on a live socket.
		connected: true,
		channels: [createChannel(7, ChannelType.VOICE), createChannel(9, ChannelType.TEXT)],
		...state,
	});
};

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
		mock.module('@/lib/trpc', () => ({
			getWsClientInstanceId: () => 'own-client-instance',
			getTRPCClient: () => ({
				voice: {
					join: {
						mutate: joinMutate,
					},
					leave: {
						mutate: leaveMutate,
					},
					updateState: {
						mutate: updateStateMutate,
					},
				},
			}),
		}));
		mock.module('../provider-cleanup', () => ({
			runVoiceProviderCleanup,
		}));

		({
			addUserToVoiceChannel,
			clearOwnVoiceSessionAfterReconnectFailure,
			leaveVoiceSessionAfterRecoveryFailure,
			sendOwnVoiceStateUpdate,
			removeUserFromVoiceChannel,
			handleStreamWatcherActivity,
			handleVoiceSessionReplaced,
			joinVoice,
			leaveVoice,
			__resetVoiceSwitchStateForTests: resetVoiceSwitchStateForTests,
			updateVoiceUserState,
			flushVoiceForDesktopQuit,
		} = await import('../actions'));
	});

	beforeEach(() => {
		useServerStore.getState().resetState();
		useVoiceReconnectStore.getState().resetState();
		playSound.mockClear();
		runVoiceProviderCleanup.mockClear();
		joinMutate.mockClear();
		leaveMutate.mockClear();
		updateStateMutate.mockClear();
		waitBeforeUpdateStateResolve = undefined;
		resetVoiceSwitchStateForTests();
		joinShouldFail = false;
		leaveShouldFail = false;
		joinHangsUntilAborted = false;
		beforeJoinResolve = undefined;
		waitBeforeLeaveResolve = undefined;
	});

	it('clears own active voice state when the server removes the current user from voice', () => {
		setJoinedVoiceChannelState({
			ownUserId: 42,
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
		expect(runVoiceProviderCleanup).toHaveBeenCalledTimes(1);
	});

	it('does not play the own leave sound for reconnect bookkeeping', () => {
		setJoinedVoiceChannelState({
			ownUserId: 42,
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
		expect(runVoiceProviderCleanup).not.toHaveBeenCalled();
	});

	it('keeps the current voice session when switching channels fails before server eviction', async () => {
		setJoinedVoiceChannelState({
			ownUserId: 42,
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
		joinShouldFail = true;

		const result = await joinVoice(8, { silent: true });

		expect(result.kind).toBe('retryable-failure');
		expect(useServerStore.getState().currentVoiceChannelId).toBe(7);
		expect(useServerStore.getState().voiceMap[7]?.users[42]).toBeDefined();
		expect(leaveMutate).not.toHaveBeenCalled();
		expect(runVoiceProviderCleanup).not.toHaveBeenCalled();
	});

	it('treats old-channel own leave during a voice switch as server eviction bookkeeping', async () => {
		setJoinedVoiceChannelState({
			ownUserId: 42,
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
		beforeJoinResolve = () => {
			removeUserFromVoiceChannel(42, 7);
		};

		const result = await joinVoice(8, { silent: true });

		expect(result.kind).toBe('joined');
		expect(useServerStore.getState().currentVoiceChannelId).toBe(8);
		expect(playSound).not.toHaveBeenCalledWith(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
		expect(playSound).toHaveBeenCalledWith(SoundType.OWN_USER_JOINED_VOICE_CHANNEL);
		expect(leaveMutate).not.toHaveBeenCalled();
		expect(runVoiceProviderCleanup).toHaveBeenCalledTimes(1);
	});

	it('ignores late session-replaced events for the old channel after a successful switch', async () => {
		setJoinedVoiceChannelState({
			ownUserId: 42,
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

		const result = await joinVoice(8, { silent: true });
		handleVoiceSessionReplaced({ channelId: 7 });

		expect(result.kind).toBe('joined');
		expect(useServerStore.getState().currentVoiceChannelId).toBe(8);
		expect(runVoiceProviderCleanup).not.toHaveBeenCalled();
	});

	it('ignores late session-replaced events for multiple rapid channel switches', async () => {
		setJoinedVoiceChannelState({
			ownUserId: 42,
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

		const firstSwitchResult = await joinVoice(8, { silent: true });
		const secondSwitchResult = await joinVoice(9, { silent: true });

		handleVoiceSessionReplaced({ channelId: 7 });
		handleVoiceSessionReplaced({ channelId: 8 });

		expect(firstSwitchResult.kind).toBe('joined');
		expect(secondSwitchResult.kind).toBe('joined');
		expect(useServerStore.getState().currentVoiceChannelId).toBe(9);
		expect(runVoiceProviderCleanup).not.toHaveBeenCalled();
	});

	it('serializes concurrent joins and ignores replacement events for superseded successful joins', async () => {
		setJoinedVoiceChannelState({ ownUserId: 42 });

		const firstSwitch = joinVoice(8, { silent: true });
		const secondSwitch = joinVoice(9, { silent: true });
		const [firstResult, secondResult] = await Promise.all([firstSwitch, secondSwitch]);
		handleVoiceSessionReplaced({ channelId: 7 });
		handleVoiceSessionReplaced({ channelId: 8 });

		expect(firstResult.kind).toBe('retryable-failure');
		expect(secondResult.kind).toBe('joined');
		expect(joinMutate).toHaveBeenCalledTimes(2);
		expect(useServerStore.getState().currentVoiceChannelId).toBe(9);
		expect(playSound).toHaveBeenCalledTimes(1);
		expect(runVoiceProviderCleanup).not.toHaveBeenCalled();
	});

	it('does not let a rejoin overtake a terminal reconnect leave', async () => {
		setJoinedVoiceChannelState({ ownUserId: 42 });
		let resolveLeave: (() => void) | undefined;
		waitBeforeLeaveResolve = new Promise<void>((resolve) => {
			resolveLeave = resolve;
		});

		const leaveResult = leaveVoiceSessionAfterRecoveryFailure();
		clearOwnVoiceSessionAfterReconnectFailure('restore-terminal-error');
		await Promise.resolve();
		const joinResult = joinVoice(7, { silent: true });
		await Promise.resolve();

		expect(leaveMutate).toHaveBeenCalledTimes(1);
		expect(joinMutate).not.toHaveBeenCalled();

		resolveLeave?.();

		expect(await leaveResult).toBe(true);
		expect((await joinResult).kind).toBe('joined');
		expect(joinMutate).toHaveBeenCalledTimes(1);
	});

	it('skips the recovery-failure leave while the socket is disconnected', async () => {
		setJoinedVoiceChannelState({ ownUserId: 42, connected: false });

		expect(await leaveVoiceSessionAfterRecoveryFailure()).toBe(false);
		expect(leaveMutate).not.toHaveBeenCalled();
	});

	it('cancels reconnect recovery before starting a manual join', async () => {
		useVoiceReconnectStore.getState().setPendingVoiceReconnect({
			channelId: 7,
			micMuted: false,
			soundMuted: false,
			peerUserIds: [],
			expiresAt: Date.now() + 10_000,
		});
		useVoiceReconnectStore.getState().setReconnectingSince(Date.now());

		const joinResult = joinVoice(7, { silent: true });

		expect(useVoiceReconnectStore.getState().reconnectingSince).toBeUndefined();
		expect(useVoiceReconnectStore.getState().pendingVoiceReconnect).toBeUndefined();
		expect((await joinResult).kind).toBe('joined');
	});

	it('aborts an in-flight join so a leave is not stuck behind it', async () => {
		setJoinedVoiceChannelState({ ownUserId: 42 });
		joinHangsUntilAborted = true;

		const joinResult = joinVoice(8, { silent: true });
		await Promise.resolve();
		expect(joinMutate).toHaveBeenCalledTimes(1);

		// Without the abort this would deadlock: the hung join never resolves
		// and the queued leave never runs.
		await leaveVoice();

		expect(leaveMutate).toHaveBeenCalledTimes(1);
		expect((await joinResult).kind).toBe('retryable-failure');
	});

	it('serializes own voice-state updates and stamps a monotonically increasing seq', async () => {
		let resolveFirstUpdate: (() => void) | undefined;
		waitBeforeUpdateStateResolve = new Promise<void>((resolve) => {
			resolveFirstUpdate = resolve;
		});

		const firstUpdate = sendOwnVoiceStateUpdate({ micMuted: true });
		const secondUpdate = sendOwnVoiceStateUpdate({ micMuted: false });
		await Promise.resolve();

		// The second update must wait for the first to settle.
		expect(updateStateMutate).toHaveBeenCalledTimes(1);

		resolveFirstUpdate?.();
		await firstUpdate;
		await secondUpdate;

		expect(updateStateMutate).toHaveBeenCalledTimes(2);
		expect(updateStateMutate.mock.calls[0]?.[0]).toEqual({ micMuted: true, seq: 1 });
		expect(updateStateMutate.mock.calls[1]?.[0]).toEqual({ micMuted: false, seq: 2 });
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

	it('clears a pinned remote screen-share card when the server reports that user stopped sharing', () => {
		setJoinedVoiceChannelState({
			ownUserId: 42,
			voiceMap: {
				7: {
					users: {
						42: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
						10: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: true },
					},
				},
			},
			pinnedCard: {
				id: 'screen-share-10',
				type: 'screen-share',
				userId: 10,
			} as unknown as TPinnedCardState,
		});

		updateVoiceUserState(10, 7, { sharingScreen: false });

		const state = useServerStore.getState();

		expect(state.voiceMap[7]?.users[10]?.sharingScreen).toBe(false);
		expect(state.pinnedCard).toBeUndefined();
	});

	it('snapshots reconnect intent before clearing own voice state when reconnecting', () => {
		setJoinedVoiceChannelState({
			ownUserId: 42,
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
		setJoinedVoiceChannelState({
			ownUserId: 42,
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

	it('clears reconnect state and leaves voice quietly during desktop quit flush', async () => {
		setJoinedVoiceChannelState({
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
		});
		useVoiceReconnectStore.getState().setPendingVoiceReconnect({
			channelId: 7,
			micMuted: true,
			soundMuted: false,
			peerUserIds: [10],
			expiresAt: Date.now() + 10_000,
		});
		useVoiceReconnectStore.getState().setReconnectingSince(Date.now());
		useVoiceReconnectStore.getState().setVoiceReconnectSuppression({
			channelId: 7,
			peerUserIds: [10],
			expiresAt: Date.now() + 10_000,
		});

		const result = await flushVoiceForDesktopQuit();

		expect(result).toBe('succeeded');
		expect(leaveMutate).toHaveBeenCalledTimes(1);
		expect(playSound).not.toHaveBeenCalledWith(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
		expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();
		expect(useServerStore.getState().selectedChannelId).toBe(9);
		expect(ownVoiceStateSelector(useServerStore.getState())).toEqual({
			micMuted: false,
			soundMuted: false,
			webcamEnabled: false,
			sharingScreen: false,
		});
		expect(useVoiceReconnectStore.getState()).toMatchObject({
			pendingVoiceReconnect: undefined,
			reconnectingSince: undefined,
			voiceReconnectSuppression: undefined,
		});
		expect(runVoiceProviderCleanup).toHaveBeenCalledTimes(1);
	});

	it('falls back to skipped desktop quit flush when the leave call fails', async () => {
		leaveShouldFail = true;
		setJoinedVoiceChannelState();
		useVoiceReconnectStore.getState().setPendingVoiceReconnect({
			channelId: 7,
			micMuted: false,
			soundMuted: false,
			peerUserIds: [],
			expiresAt: Date.now() + 10_000,
		});

		const result = await flushVoiceForDesktopQuit();

		expect(result).toBe('skipped');
		expect(leaveMutate).toHaveBeenCalledTimes(1);
		expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();
		expect(useVoiceReconnectStore.getState().pendingVoiceReconnect).toBeUndefined();
		expect(playSound).not.toHaveBeenCalledWith(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
	});

	it('still attempts desktop quit flush when reconnect cleanup already cleared the local voice channel id', async () => {
		useVoiceReconnectStore.getState().setPendingVoiceReconnect({
			channelId: 7,
			micMuted: false,
			soundMuted: false,
			peerUserIds: [],
			expiresAt: Date.now() + 10_000,
		});
		useVoiceReconnectStore.getState().setReconnectingSince(Date.now());

		const result = await flushVoiceForDesktopQuit();

		expect(result).toBe('succeeded');
		expect(leaveMutate).toHaveBeenCalledTimes(1);
		expect(useVoiceReconnectStore.getState()).toMatchObject({
			pendingVoiceReconnect: undefined,
			reconnectingSince: undefined,
			voiceReconnectSuppression: undefined,
		});
	});

	it('tears down local voice resources on an explicit leave', async () => {
		setJoinedVoiceChannelState();

		await leaveVoice();

		expect(leaveMutate).toHaveBeenCalledTimes(1);
		expect(playSound).toHaveBeenCalledWith(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
		expect(runVoiceProviderCleanup).toHaveBeenCalledTimes(1);
	});

	it('tears down local voice resources when a voice session is replaced', () => {
		setJoinedVoiceChannelState();

		handleVoiceSessionReplaced();

		expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();
		expect(runVoiceProviderCleanup).toHaveBeenCalledTimes(1);
	});

	it('ignores a replacement event caused by this client instance even while in voice', () => {
		// The dangerous ordering: the replacer's own join response has already
		// applied (currentVoiceChannelId set) when its fan-out copy of the
		// replacement event arrives. Without the instance check it would tear
		// down the session it just created.
		setJoinedVoiceChannelState({ ownUserId: 42 });

		handleVoiceSessionReplaced({ channelId: 7, replacedByClientInstanceId: 'own-client-instance' });

		expect(useServerStore.getState().currentVoiceChannelId).toBe(7);
		expect(runVoiceProviderCleanup).not.toHaveBeenCalled();
	});

	it('still processes a replacement caused by another client instance', () => {
		setJoinedVoiceChannelState({ ownUserId: 42 });

		handleVoiceSessionReplaced({ channelId: 7, replacedByClientInstanceId: 'other-client-instance' });

		expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();
		expect(runVoiceProviderCleanup).toHaveBeenCalledTimes(1);
	});

	it('clears the captured reconnect intent when the replaced event lands after the own-leave event', () => {
		// The server's own-leave (reconnecting: true) arrives first: it clears the
		// channel state and captures reconnect intent for the replaced channel.
		useVoiceReconnectStore.getState().setPendingVoiceReconnect({
			channelId: 7,
			micMuted: false,
			soundMuted: false,
			peerUserIds: [],
			expiresAt: Date.now() + 10_000,
		});

		handleVoiceSessionReplaced({ channelId: 7 });

		// The stale intent must not survive — a later WS drop would otherwise try
		// to restore into a channel another connection now owns.
		expect(useVoiceReconnectStore.getState().pendingVoiceReconnect).toBeUndefined();
	});

	it('ignores a replaced event when this connection held neither the session nor its reconnect intent', () => {
		useVoiceReconnectStore.getState().setPendingVoiceReconnect({
			channelId: 8,
			micMuted: false,
			soundMuted: false,
			peerUserIds: [],
			expiresAt: Date.now() + 10_000,
		});

		handleVoiceSessionReplaced({ channelId: 7 });

		expect(useVoiceReconnectStore.getState().pendingVoiceReconnect?.channelId).toBe(8);
	});

	it('clears sticky local voice state when reconnect recovery terminates', () => {
		setJoinedVoiceChannelState({
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
		});
		useVoiceReconnectStore.getState().setPendingVoiceReconnect({
			channelId: 7,
			micMuted: false,
			soundMuted: false,
			peerUserIds: [10],
			expiresAt: Date.now() + 10_000,
		});
		useVoiceReconnectStore.getState().setReconnectingSince(Date.now());
		useVoiceReconnectStore.getState().setVoiceReconnectSuppression({
			channelId: 7,
			peerUserIds: [10],
			expiresAt: Date.now() + 10_000,
		});

		clearOwnVoiceSessionAfterReconnectFailure('restore-terminal-error');

		expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();
		expect(useServerStore.getState().selectedChannelId).toBe(9);
		expect(ownVoiceStateSelector(useServerStore.getState())).toEqual({
			micMuted: false,
			soundMuted: false,
			webcamEnabled: false,
			sharingScreen: false,
		});
		expect(useVoiceReconnectStore.getState()).toMatchObject({
			pendingVoiceReconnect: undefined,
			reconnectingSince: undefined,
			voiceReconnectSuppression: undefined,
		});
		expect(runVoiceProviderCleanup).toHaveBeenCalledTimes(1);
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
