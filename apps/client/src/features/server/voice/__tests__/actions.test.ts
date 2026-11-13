import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { ChannelType, StreamKind, type TPublicChannel } from '@sharkord/shared';
import { createSessionAuthenticationGate } from '@/lib/session-authentication-gate';
import { useServerStore } from '../../slice';
import { SoundType } from '../../types';
import type { TPendingVoiceReconnect, TVoiceReconnectSuppression } from '../reconnect-coordinator';
import { ownVoiceStateSelector } from '../selectors';
import {
	selectPendingVoiceReconnect,
	selectReconnectingSince,
	selectVoiceReconnectSuppression,
	VOICE_RECONNECT_SUPPRESSION_MS,
} from '../voice-session-machine';
import { dispatchVoiceSession, resetVoiceSessionState, selectVoiceSessionState } from '../voice-session-store';

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
let relayOwnVoiceState: typeof import('../actions').relayOwnVoiceState;
let setOwnVoiceIntent: typeof import('../actions').setOwnVoiceIntent;
let setOwnPushHold: typeof import('../actions').setOwnPushHold;
let authenticated = true;
let connectionListener = () => {};
const playSound = mock(() => {});
const runVoiceProviderCleanup = mock(() => {});
const sessionAuthentication = createSessionAuthenticationGate();
let leaveShouldFail = false;
let joinShouldFail = false;
let joinFailureCode: 'UNAUTHORIZED' | 'FORBIDDEN' | undefined;
let joinAbortObserved = false;
let beforeJoinResolve: (() => void) | undefined;
let waitBeforeJoinResolve: Promise<void> | undefined;
let waitBeforeLeaveResolve: Promise<void> | undefined;
const joinMutate = mock(async (_input?: unknown, opts?: { signal?: AbortSignal }) => {
	const signal = opts?.signal;
	if (signal?.aborted) {
		joinAbortObserved = true;
	} else {
		signal?.addEventListener('abort', () => {
			joinAbortObserved = true;
		});
	}
	await waitBeforeJoinResolve;

	if (joinShouldFail) {
		throw Object.assign(new Error('join failed'), { data: { code: joinFailureCode } });
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
const leaveMutate = mock(async (_input?: unknown) => {
	await waitBeforeLeaveResolve;
	if (leaveShouldFail) {
		throw new Error('leave failed');
	}
});
let waitBeforeUpdateStateResolve: Promise<void> | undefined;
const updateStateMutate = mock(async (_input?: unknown) => {
	await waitBeforeUpdateStateResolve;
});

let clientIdentity = {
	voice: { join: { mutate: joinMutate }, leave: { mutate: leaveMutate }, updateState: { mutate: updateStateMutate } },
};
let screenShareCardType: TPinnedCardState['type'];
type TPinnedCardState = NonNullable<ReturnType<typeof useServerStore.getState>['pinnedCard']>;

const createChannel = (id: number, type: ChannelType): TPublicChannel =>
	({
		id,
		type,
	}) as unknown as TPublicChannel;

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
		// The recovery-failure leave only fires while the app holds a server session.
		hasServerSession: true,
		channels: [createChannel(7, ChannelType.VOICE), createChannel(9, ChannelType.TEXT)],
		...state,
	});
};

const setPendingVoiceReconnect = (pending: TPendingVoiceReconnect): void => {
	dispatchVoiceSession({ type: 'ReconnectIntentCaptured', pending });
};

const startVoiceReconnect = (now: number): void => {
	dispatchVoiceSession({
		type: 'WsDropped',
		pending: selectVoiceSessionState(selectPendingVoiceReconnect),
		now,
		online: true,
	});
};

const setVoiceReconnectSuppression = (suppression: TVoiceReconnectSuppression): void => {
	const [capture] = dispatchVoiceSession({
		type: 'WsDropped',
		pending: { ...suppression, micMuted: false, soundMuted: false },
		now: suppression.expiresAt - VOICE_RECONNECT_SUPPRESSION_MS,
		online: true,
	});
	if (capture?.type !== 'CaptureRecoverySnapshot') throw new Error('expected recovery snapshot command');
	const [auth] = dispatchVoiceSession({
		...capture,
		type: 'RecoveryStarted',
		snapshot: { remoteUserStreams: {}, externalStreams: {} },
	});
	if (auth?.type !== 'WaitAuth') throw new Error('expected authentication command');
	const [restore] = dispatchVoiceSession({ ...auth, type: 'AuthReady' });
	if (restore?.type !== 'RestoreVoiceSession') throw new Error('expected restore command');
	const [watch] = dispatchVoiceSession({ ...restore, type: 'RestoreSucceeded' });
	if (watch?.type !== 'RestoreWatchIntent') throw new Error('expected watch restore command');
	dispatchVoiceSession({
		...watch,
		type: 'WatchIntentRehydrated',
		now: suppression.expiresAt - VOICE_RECONNECT_SUPPRESSION_MS,
	});
};

const getPendingVoiceReconnect = (): TPendingVoiceReconnect | undefined =>
	selectVoiceSessionState(selectPendingVoiceReconnect);
const getReconnectingSince = (): number | undefined => selectVoiceSessionState(selectReconnectingSince);
const getVoiceReconnectSuppression = (): TVoiceReconnectSuppression | undefined =>
	selectVoiceSessionState(selectVoiceReconnectSuppression);

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
			waitForTRPCSessionAuthentication: sessionAuthentication.wait,
			getWsClientInstanceId: () => 'own-client-instance',
			getTRPCClient: () => clientIdentity,
			getTRPCClientIfInitialized: () => clientIdentity,
			isTRPCSessionAuthenticated: () => authenticated,
			subscribeServerConnectionState: (listener: () => void) => {
				connectionListener = listener;
				return () => {};
			},
			TRPCClientUnavailableError: class extends Error {},
		}));
		mock.module('../provider-cleanup', () => ({
			runVoiceProviderCleanup,
		}));

		({
			relayOwnVoiceState,
			setOwnVoiceIntent,
			setOwnPushHold,
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
		screenShareCardType = (await import('@/components/channel-view/voice/hooks/use-pin-card-controller')).PinnedCardType
			.SCREEN_SHARE;
	});

	beforeEach(() => {
		useServerStore.getState().resetState();
		useServerStore.getState().setOwnVoiceIntent({ micMuted: false, soundMuted: false });
		resetVoiceSessionState();
		playSound.mockClear();
		runVoiceProviderCleanup.mockClear();
		joinMutate.mockClear();
		leaveMutate.mockClear();
		updateStateMutate.mockClear();
		waitBeforeUpdateStateResolve = undefined;
		resetVoiceSwitchStateForTests();
		authenticated = true;
		sessionAuthentication.cancel(new Error('Test reset'));
		sessionAuthentication.authenticate();
		joinShouldFail = false;
		joinFailureCode = undefined;
		leaveShouldFail = false;
		joinAbortObserved = false;
		beforeJoinResolve = undefined;
		waitBeforeJoinResolve = undefined;
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
			ownVoiceIntent: {
				micMuted: false,
				soundMuted: false,
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
		expect(state.ownVoiceIntent).toEqual({
			micMuted: false,
			soundMuted: false,
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
		expect(leaveMutate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ reason: 'recovery_exhausted' }));
		expect((await joinResult).kind).toBe('joined');
		expect(joinMutate).toHaveBeenCalledTimes(1);
	});

	it('skips the recovery-failure leave after the server session is torn down', async () => {
		setJoinedVoiceChannelState({ ownUserId: 42, hasServerSession: false });

		expect(await leaveVoiceSessionAfterRecoveryFailure()).toBe(false);
		expect(leaveMutate).not.toHaveBeenCalled();
	});

	it('stops local capture immediately but waits for replacement socket authentication before leaving', async () => {
		setJoinedVoiceChannelState({ ownUserId: 42 });
		sessionAuthentication.invalidate();
		const leave = leaveVoice();
		expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();
		expect(runVoiceProviderCleanup).toHaveBeenCalledTimes(1);
		expect(leaveMutate).not.toHaveBeenCalled();
		sessionAuthentication.authenticate();
		await leave;
		expect(leaveMutate).toHaveBeenCalledTimes(1);
	});

	it('keeps a replacement join behind the leave while authentication is pending', async () => {
		setJoinedVoiceChannelState({ ownUserId: 42 });
		sessionAuthentication.invalidate();
		const leave = leaveVoice();
		const join = joinVoice(8, { silent: true });
		for (let i = 0; i < 5; i += 1) await Promise.resolve();
		expect(joinMutate).not.toHaveBeenCalled();
		expect(leaveMutate).not.toHaveBeenCalled();
		sessionAuthentication.authenticate();
		await leave;
		expect((await join).kind).toBe('joined');
		expect(leaveMutate).toHaveBeenCalledTimes(1);
		expect(leaveMutate.mock.calls[0]?.[0]).toEqual({ mutationSeq: 1, reason: 'user_action' });
		expect(joinMutate.mock.calls[0]?.[0]).toMatchObject({ channelId: 8, mutationSeq: 2 });
		expect(useServerStore.getState().currentVoiceChannelId).toBe(8);
	});

	for (const failureCode of [undefined, 'UNAUTHORIZED', 'FORBIDDEN'] as const) {
		it(`preserves pending leave cleanup when a replacement join fails with ${failureCode ?? 'a transport error'}`, async () => {
			setJoinedVoiceChannelState({ ownUserId: 42 });
			sessionAuthentication.invalidate();
			const leave = leaveVoice();
			joinShouldFail = true;
			joinFailureCode = failureCode;
			const join = joinVoice(8, { silent: true });
			sessionAuthentication.authenticate();
			await leave;
			expect((await join).kind).toBe(failureCode ? 'non-retriable-failure' : 'retryable-failure');
			expect(leaveMutate).toHaveBeenCalledTimes(1);
			expect(leaveMutate.mock.calls[0]?.[0]).toEqual({ mutationSeq: 1, reason: 'user_action' });
			expect(joinMutate.mock.calls[0]?.[0]).toMatchObject({ mutationSeq: 2 });
			expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();
			expect(runVoiceProviderCleanup).toHaveBeenCalledTimes(1);
		});
	}

	it('does not replay a pending leave after application teardown', async () => {
		setJoinedVoiceChannelState({ ownUserId: 42 });
		sessionAuthentication.invalidate();
		const leave = leaveVoice();
		sessionAuthentication.cancel(new Error('Connection closed'));
		await leave;
		sessionAuthentication.authenticate();
		await Promise.resolve();
		expect(leaveMutate).not.toHaveBeenCalled();
	});

	it('cancels reconnect recovery before starting a manual join', async () => {
		setPendingVoiceReconnect({
			channelId: 7,
			micMuted: false,
			soundMuted: false,
			peerUserIds: [],
			expiresAt: Date.now() + 10_000,
		});
		startVoiceReconnect(Date.now());

		const joinResult = joinVoice(7, { silent: true });

		expect(getReconnectingSince()).toBeUndefined();
		expect(getPendingVoiceReconnect()).toBeUndefined();
		expect((await joinResult).kind).toBe('joined');
	});

	it('aborts an in-flight join and sends a newer leave mutation immediately', async () => {
		setJoinedVoiceChannelState({ ownUserId: 42 });
		let resolveJoin: (() => void) | undefined;
		waitBeforeJoinResolve = new Promise<void>((resolve) => {
			resolveJoin = resolve;
		});

		const joinResult = joinVoice(8, { silent: true });
		await Promise.resolve();
		expect(joinMutate).toHaveBeenCalledTimes(1);

		await leaveVoice();

		expect(leaveMutate).toHaveBeenCalledTimes(1);
		expect(joinAbortObserved).toBe(true);
		expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();
		expect(joinMutate.mock.calls[0]?.[0]).toMatchObject({ mutationSeq: 1 });
		expect(leaveMutate.mock.calls[0]?.[0]).toEqual({ mutationSeq: 2, reason: 'user_action' });

		resolveJoin?.();
		expect((await joinResult).kind).toBe('retryable-failure');
	});

	it('serializes own voice-state updates and stamps a monotonically increasing seq', async () => {
		useServerStore.setState({ currentVoiceChannelId: 7 });
		let resolveFirstUpdate: (() => void) | undefined;
		waitBeforeUpdateStateResolve = new Promise<void>((resolve) => {
			resolveFirstUpdate = resolve;
		});

		const firstUpdate = sendOwnVoiceStateUpdate({ webcamEnabled: true });
		const secondUpdate = sendOwnVoiceStateUpdate({ webcamEnabled: false });
		await Promise.resolve();

		// The second update must wait for the first to settle.
		expect(updateStateMutate).toHaveBeenCalledTimes(1);

		resolveFirstUpdate?.();
		await firstUpdate;
		await secondUpdate;

		expect(updateStateMutate).toHaveBeenCalledTimes(2);
		expect(updateStateMutate.mock.calls[0]?.[0]).toEqual({ webcamEnabled: true, seq: 1 });
		expect(updateStateMutate.mock.calls[1]?.[0]).toEqual({ webcamEnabled: false, seq: 2 });
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

	it('applies synced screen share watcher updates without a cue', () => {
		handleStreamWatcherActivity({ watcherId: 10, action: 'joined', kind: StreamKind.SCREEN, sync: true });
		expect(useServerStore.getState().screenShareWatchers).toEqual({ 10: true });

		handleStreamWatcherActivity({ watcherId: 10, action: 'left', kind: StreamKind.SCREEN, sync: true });
		expect(useServerStore.getState().screenShareWatchers).toEqual({});

		expect(playSound).not.toHaveBeenCalled();
	});

	it('keeps screen share viewers when an active share is restated', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
			voiceMap: {
				7: {
					users: {
						42: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: true },
					},
				},
			},
		});
		handleStreamWatcherActivity({ watcherId: 10, action: 'joined', kind: StreamKind.SCREEN });

		useServerStore.getState().updateOwnVoiceState({ sharingScreen: true });
		expect(useServerStore.getState().screenShareWatchers).toEqual({ 10: true });

		useServerStore.getState().updateOwnVoiceState({ sharingScreen: false });
		expect(useServerStore.getState().screenShareWatchers).toEqual({});
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
			ownVoiceIntent: {
				micMuted: true,
				soundMuted: false,
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

		// But reconnect intent should be preserved in the session machine.
		const pendingVoiceReconnect = getPendingVoiceReconnect();
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

		expect(getPendingVoiceReconnect()).toBeUndefined();
	});

	it('suppresses remote join sounds for peers captured in reconnect suppression', () => {
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: 7,
		});
		setVoiceReconnectSuppression({
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
		setVoiceReconnectSuppression({
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
			ownVoiceIntent: {
				micMuted: false,
				soundMuted: false,
			},
		});
		setVoiceReconnectSuppression({
			channelId: 7,
			peerUserIds: [10],
			expiresAt: Date.now() + 10_000,
		});
		setPendingVoiceReconnect({
			channelId: 7,
			micMuted: true,
			soundMuted: false,
			peerUserIds: [10],
			expiresAt: Date.now() + 10_000,
		});
		startVoiceReconnect(Date.now());

		const result = await flushVoiceForDesktopQuit();

		expect(result).toBe('succeeded');
		expect(leaveMutate).toHaveBeenCalledTimes(1);
		expect(leaveMutate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ reason: 'app_quit' }));
		expect(playSound).not.toHaveBeenCalledWith(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
		expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();
		expect(useServerStore.getState().selectedChannelId).toBe(9);
		expect(ownVoiceStateSelector(useServerStore.getState())).toEqual({
			micMuted: false,
			soundMuted: false,
			webcamEnabled: false,
			sharingScreen: false,
		});
		expect(getPendingVoiceReconnect()).toBeUndefined();
		expect(getReconnectingSince()).toBeUndefined();
		expect(getVoiceReconnectSuppression()).toBeUndefined();
		expect(runVoiceProviderCleanup).toHaveBeenCalledTimes(1);
	});

	it('falls back to skipped desktop quit flush when the leave call fails', async () => {
		leaveShouldFail = true;
		setJoinedVoiceChannelState();
		setPendingVoiceReconnect({
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
		expect(getPendingVoiceReconnect()).toBeUndefined();
		expect(playSound).not.toHaveBeenCalledWith(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
	});

	it('still attempts desktop quit flush when reconnect cleanup already cleared the local voice channel id', async () => {
		setPendingVoiceReconnect({
			channelId: 7,
			micMuted: false,
			soundMuted: false,
			peerUserIds: [],
			expiresAt: Date.now() + 10_000,
		});
		startVoiceReconnect(Date.now());

		const result = await flushVoiceForDesktopQuit();

		expect(result).toBe('succeeded');
		expect(leaveMutate).toHaveBeenCalledTimes(1);
		expect(leaveMutate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ reason: 'app_quit' }));
		expect(getPendingVoiceReconnect()).toBeUndefined();
		expect(getReconnectingSince()).toBeUndefined();
		expect(getVoiceReconnectSuppression()).toBeUndefined();
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
		setPendingVoiceReconnect({
			channelId: 7,
			micMuted: false,
			soundMuted: false,
			peerUserIds: [],
			expiresAt: Date.now() + 10_000,
		});

		handleVoiceSessionReplaced({ channelId: 7 });

		// The stale intent must not survive — a later WS drop would otherwise try
		// to restore into a channel another connection now owns.
		expect(getPendingVoiceReconnect()).toBeUndefined();
	});

	it('ignores a replaced event when this connection held neither the session nor its reconnect intent', () => {
		setPendingVoiceReconnect({
			channelId: 8,
			micMuted: false,
			soundMuted: false,
			peerUserIds: [],
			expiresAt: Date.now() + 10_000,
		});

		handleVoiceSessionReplaced({ channelId: 7 });

		expect(getPendingVoiceReconnect()?.channelId).toBe(8);
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
			ownVoiceIntent: {
				micMuted: false,
				soundMuted: false,
			},
		});
		setVoiceReconnectSuppression({
			channelId: 7,
			peerUserIds: [10],
			expiresAt: Date.now() + 10_000,
		});
		setPendingVoiceReconnect({
			channelId: 7,
			micMuted: false,
			soundMuted: false,
			peerUserIds: [10],
			expiresAt: Date.now() + 10_000,
		});
		startVoiceReconnect(Date.now());

		clearOwnVoiceSessionAfterReconnectFailure('restore-terminal-error');

		expect(useServerStore.getState().currentVoiceChannelId).toBeUndefined();
		expect(useServerStore.getState().selectedChannelId).toBe(9);
		expect(ownVoiceStateSelector(useServerStore.getState())).toEqual({
			micMuted: false,
			soundMuted: false,
			webcamEnabled: false,
			sharingScreen: false,
		});
		expect(getPendingVoiceReconnect()).toBeUndefined();
		expect(getReconnectingSince()).toBeUndefined();
		expect(getVoiceReconnectSuppression()).toBeUndefined();
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
		setVoiceReconnectSuppression({
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

describe('own mute relay queue', () => {
	const flush = async () => {
		for (let i = 0; i < 8; i += 1) await Promise.resolve();
	};
	beforeEach(() => {
		useServerStore.getState().resetState();
		useServerStore.setState({ currentVoiceChannelId: 7, ownVoiceIntent: { micMuted: false, soundMuted: false } });
		resetVoiceSwitchStateForTests();
		authenticated = true;
		updateStateMutate.mockClear();
		waitBeforeUpdateStateResolve = undefined;
	});
	it('coalesces queued changes and reads the latest full pair when sent', async () => {
		const first = relayOwnVoiceState();
		setOwnVoiceIntent({ micMuted: true });
		const second = relayOwnVoiceState();
		expect(second).toBe(first);
		await first;
		expect(updateStateMutate.mock.calls.map(([input]) => input)).toEqual([
			{ micMuted: true, soundMuted: false, seq: 1 },
		]);
	});
	it('sends exactly one trailing latest pair after an in-flight relay', async () => {
		let release = () => {};
		waitBeforeUpdateStateResolve = new Promise<void>((yes) => {
			release = yes;
		});
		const first = relayOwnVoiceState();
		await flush();
		setOwnVoiceIntent({ micMuted: true });
		setOwnVoiceIntent({ soundMuted: true });
		const trailing = relayOwnVoiceState();
		release();
		await Promise.all([first, trailing]);
		expect(updateStateMutate.mock.calls.map(([input]) => input)).toEqual([
			{ micMuted: false, soundMuted: false, seq: 1 },
			{ micMuted: true, soundMuted: true, seq: 2 },
		]);
	});
	for (const retirement of ['leave-rejoin', 'socket-reopen', 'client-replacement'] as const)
		it(`rejects retired video and skips retired relay after ${retirement}`, async () => {
			let release = () => {};
			waitBeforeUpdateStateResolve = new Promise<void>((yes) => {
				release = yes;
			});
			const blocking = sendOwnVoiceStateUpdate({ webcamEnabled: true });
			await flush();
			const oldRelay = relayOwnVoiceState();
			const oldVideo = sendOwnVoiceStateUpdate({ sharingScreen: true }).then(
				() => false,
				() => true,
			);
			if (retirement === 'leave-rejoin') {
				useServerStore.getState().setCurrentVoiceChannelId(undefined);
				useServerStore.getState().setCurrentVoiceChannelId(7);
			}
			if (retirement === 'socket-reopen') {
				authenticated = false;
				connectionListener();
				authenticated = true;
				connectionListener();
			}
			if (retirement === 'client-replacement') clientIdentity = { ...clientIdentity };
			release();
			await blocking;
			await oldRelay;
			expect(await oldVideo).toBe(true);
			expect(updateStateMutate).toHaveBeenCalledTimes(1);
			await relayOwnVoiceState();
			expect(updateStateMutate).toHaveBeenCalledTimes(2);
		});
	it('skips unauthenticated and off-channel sends while keeping intent', async () => {
		authenticated = false;
		setOwnVoiceIntent({ micMuted: true });
		await relayOwnVoiceState();
		expect(updateStateMutate).not.toHaveBeenCalled();
		authenticated = true;
		useServerStore.getState().setCurrentVoiceChannelId(undefined);
		await relayOwnVoiceState();
		expect(updateStateMutate).not.toHaveBeenCalled();
		expect(useServerStore.getState().ownVoiceIntent.micMuted).toBe(true);
	});
	it('contains relay failure and later sends current intent', async () => {
		updateStateMutate.mockImplementationOnce(async () => {
			throw new Error('socket');
		});
		setOwnVoiceIntent({ micMuted: true });
		await relayOwnVoiceState();
		expect(useServerStore.getState().ownVoiceIntent.micMuted).toBe(true);
		setOwnVoiceIntent({ soundMuted: true });
		await relayOwnVoiceState();
		expect(updateStateMutate.mock.calls.at(-1)?.[0]).toMatchObject({ micMuted: true, soundMuted: true });
	});
	it('orders sequence numbers at send time across relay and video', async () => {
		const relay = relayOwnVoiceState();
		const video = sendOwnVoiceStateUpdate({ webcamEnabled: true });
		await Promise.all([relay, video]);
		expect(updateStateMutate.mock.calls.map(([input]) => input)).toEqual([
			{ micMuted: false, soundMuted: false, seq: 1 },
			{ webcamEnabled: true, seq: 2 },
		]);
	});
});

describe('own session presentation boundaries', () => {
	beforeEach(() => {
		useServerStore.getState().resetState();
		useServerStore.getState().setOwnVoiceIntent({ micMuted: true, soundMuted: false });
		resetVoiceSessionState();
		resetVoiceSwitchStateForTests();
		updateStateMutate.mockClear();
		authenticated = true;
	});
	it('a hold relays the effective pair without changing reconnect intent', async () => {
		useServerStore.setState({ ownUserId: 42, currentVoiceChannelId: 7 });
		const before = selectVoiceSessionState((state) => state);
		setOwnPushHold({ talk: true, mute: false });
		await relayOwnVoiceState();
		expect(updateStateMutate.mock.calls.at(-1)?.[0]).toMatchObject({ micMuted: false, soundMuted: false });
		setOwnPushHold({ talk: false, mute: false });
		await relayOwnVoiceState();
		expect(selectVoiceSessionState((state) => state)).toBe(before);
		expect(updateStateMutate.mock.calls.at(-1)?.[0]).toMatchObject({ micMuted: true, soundMuted: false });
		expect(useServerStore.getState().ownVoiceIntent.micMuted).toBe(true);
	});
	for (const current of [7, undefined])
		it(`another channel cannot unpin this session: ${current}`, () => {
			useServerStore.setState({
				currentVoiceChannelId: current,
				ownUserId: 42,
				pinnedCard: { id: 'screen-share-42', type: screenShareCardType, userId: 42 },
				voiceMap: {
					8: { users: { 42: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: true } } },
				},
			});
			updateVoiceUserState(42, 8, { sharingScreen: false });
			expect(useServerStore.getState().pinnedCard?.id).toBe('screen-share-42');
		});
	it('does not unpin a share picker on a false-to-false own echo', () => {
		useServerStore.setState({
			currentVoiceChannelId: 7,
			ownUserId: 42,
			pinnedCard: { id: 'screen-share-42', type: screenShareCardType, userId: 42 },
			voiceMap: {
				7: { users: { 42: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false } } },
			},
		});
		updateVoiceUserState(42, 7, { sharingScreen: false });
		expect(useServerStore.getState().pinnedCard?.id).toBe('screen-share-42');
	});
	it('a fresh client with a handshake-adopted high-seq seat waits for explicit join before its low-seq relay', async () => {
		let lastSeq = 9000;
		const applied: number[] = [];
		updateStateMutate.mockImplementation(async (input) => {
			if (
				typeof input === 'object' &&
				input !== null &&
				'seq' in input &&
				typeof input.seq === 'number' &&
				input.seq > lastSeq
			) {
				lastSeq = input.seq;
				applied.push(input.seq);
			}
		});
		useServerStore.setState({
			ownUserId: 42,
			currentVoiceChannelId: undefined,
			voiceMap: {
				7: { users: { 42: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false } } },
			},
		});
		setOwnVoiceIntent({ micMuted: true });
		await relayOwnVoiceState();
		expect(updateStateMutate).not.toHaveBeenCalled();
		expect(getPendingVoiceReconnect()).toBeUndefined();
		beforeJoinResolve = () => {
			lastSeq = 0;
		};
		await joinVoice(7, { silent: true });
		await relayOwnVoiceState();
		expect(applied[0]).toBe(1);
		expect(joinMutate.mock.calls.at(-1)?.[0]).toMatchObject({ state: { micMuted: true, soundMuted: false } });
		updateStateMutate.mockImplementation(async () => {
			await waitBeforeUpdateStateResolve;
		});
		beforeJoinResolve = undefined;
	});
});
