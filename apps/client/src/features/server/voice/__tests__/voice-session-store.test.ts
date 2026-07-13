import { beforeEach, describe, expect, it } from 'bun:test';
import {
	selectPendingVoiceReconnect,
	selectReconnectAuthenticated,
	selectReconnectingSince,
	selectVoiceReconnectSuppression,
} from '../voice-session-machine';
import {
	dispatchVoiceSession,
	getVoiceSessionState,
	isVoiceSessionCommandCurrent,
	registerVoiceSessionCommandRunner,
	resetVoiceSessionState,
	selectVoiceSessionState,
	subscribeVoiceSession,
	subscribeVoiceSessionState,
} from '../voice-session-store';

const pendingReconnect = {
	channelId: 5,
	micMuted: true,
	soundMuted: false,
	peerUserIds: [10],
	expiresAt: 60_000,
};

// Drives the machine through a full transport rebuild with no runner
// registered, leaving the final RecoverDesktopAppAudio command in the buffer.
// Uses the commands returned by dispatch (delivery-independent) to feed the
// result events their commandId/generation.
const driveRebuildToSuccessWithNoRunner = (): void => {
	const [snapshotCommand] = dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });

	if (snapshotCommand?.type !== 'CaptureRecoverySnapshot') {
		throw new Error('expected CaptureRecoverySnapshot command');
	}

	const [rebuildCommand] = dispatchVoiceSession({
		type: 'RecoveryStarted',
		commandId: snapshotCommand.commandId,
		generation: snapshotCommand.generation,
		snapshot: { remoteUserStreams: {}, externalStreams: {} },
	});

	if (rebuildCommand?.type !== 'RebuildTransports') {
		throw new Error('expected RebuildTransports command');
	}

	dispatchVoiceSession({
		type: 'RebuildSucceeded',
		commandId: rebuildCommand.commandId,
		generation: rebuildCommand.generation,
	});
};

describe('voice session store', () => {
	beforeEach(() => {
		resetVoiceSessionState();
	});

	it('dispatches through the reducer and exposes selector reads', () => {
		const commands = dispatchVoiceSession({ type: 'JoinRequested', channelId: 5 });

		expect(commands).toEqual([]);
		expect(getVoiceSessionState().phase).toEqual({ phase: 'joining', channelId: 5 });
		expect(selectVoiceSessionState((state) => state.phase.phase)).toBe('joining');
	});

	it('notifies subscribers with reducer commands', () => {
		const notifications: Array<{ phase: string; commandTypes: string[] }> = [];
		const unsubscribe = subscribeVoiceSession((state, commands) => {
			notifications.push({
				phase: state.phase.phase,
				commandTypes: commands.map((command) => command.type),
			});
		});

		dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });
		unsubscribe();
		dispatchVoiceSession({ type: 'Terminated', reason: 'kicked', channelId: 5 });

		expect(notifications).toEqual([
			{
				phase: 'rebuilding',
				commandTypes: ['CaptureRecoverySnapshot'],
			},
		]);
	});

	it('preserves subscribers when state is reset', () => {
		const observedPhases: string[] = [];
		const unsubscribe = subscribeVoiceSession((state) => {
			observedPhases.push(state.phase.phase);
		});

		resetVoiceSessionState();
		dispatchVoiceSession({ type: 'JoinRequested', channelId: 5 });
		unsubscribe();

		expect(observedPhases).toEqual(['joining']);
	});

	it('delivers commands to the registered runner and stops after unregister', () => {
		const executed: string[] = [];
		const unregister = registerVoiceSessionCommandRunner((commands) => {
			executed.push(...commands.map((command) => command.type));
		});

		dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });
		unregister();
		dispatchVoiceSession({ type: 'Terminated', reason: 'kicked', channelId: 5 });

		expect(executed).toEqual(['CaptureRecoverySnapshot']);
	});

	it('buffers a final command dispatched with no runner and flushes it to the next runner', () => {
		// Simulates the remount gap: the old provider's async work dispatches
		// RebuildSucceeded after the old runner unregistered and before the new
		// one registered. The final RecoverDesktopAppAudio command must reach the
		// new runner, not vanish. Recovery-step commands (CaptureRecoverySnapshot,
		// RebuildTransports) are dropped from the buffer instead — Resumed
		// re-issues those, and a flushed duplicate would race it.
		driveRebuildToSuccessWithNoRunner();

		const executed: string[] = [];
		const unregister = registerVoiceSessionCommandRunner((commands) => {
			executed.push(...commands.map((command) => command.type));
		});

		expect(executed).toEqual(['RecoverDesktopAppAudio']);

		// Once flushed, the buffer is empty — a second runner gets nothing stale.
		unregister();
		const executedByNext: string[] = [];
		const unregisterNext = registerVoiceSessionCommandRunner((commands) => {
			executedByNext.push(...commands.map((command) => command.type));
		});

		unregisterNext();
		expect(executedByNext).toEqual([]);
	});

	it('does not flush a buffered recovery command into a later session, even when connected', () => {
		// The buffered RecoverDesktopAppAudio belongs to the rebuilt session's
		// incarnation. If the user ends up connected again via a fresh join
		// before a runner registers, the stale recovery must not publish old
		// app-audio intent into the new session.
		driveRebuildToSuccessWithNoRunner();
		dispatchVoiceSession({ type: 'RecoveryCleared', reason: 'kicked' });
		dispatchVoiceSession({ type: 'JoinRequested', channelId: 6 });
		dispatchVoiceSession({ type: 'JoinSucceeded', channelId: 6 });

		const executed: string[] = [];
		const unregister = registerVoiceSessionCommandRunner((commands) => {
			executed.push(...commands.map((command) => command.type));
		});

		unregister();
		expect(executed).toEqual([]);
	});

	it('drops buffered commands invalidated by a lifecycle change before a runner registers', () => {
		// Logout/app teardown between the buffered final command and the next
		// provider mount: the stale command must not fire against a later session.
		driveRebuildToSuccessWithNoRunner();
		dispatchVoiceSession({ type: 'RecoveryCleared', reason: 'kicked' });

		const executed: string[] = [];
		const unregister = registerVoiceSessionCommandRunner((commands) => {
			executed.push(...commands.map((command) => command.type));
		});

		unregister();
		expect(executed).toEqual([]);
	});

	it('drops buffered commands when state is reset', () => {
		dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });
		resetVoiceSessionState();

		const executed: string[] = [];
		const unregister = registerVoiceSessionCommandRunner((commands) => {
			executed.push(...commands.map((command) => command.type));
		});

		unregister();
		expect(executed).toEqual([]);
	});

	it('tracks live command currency for recovery-step commands', () => {
		const [snapshotCommand] = dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });

		if (snapshotCommand?.type !== 'CaptureRecoverySnapshot') {
			throw new Error('expected CaptureRecoverySnapshot command');
		}

		expect(isVoiceSessionCommandCurrent(snapshotCommand)).toBe(true);

		const [rebuildCommand] = dispatchVoiceSession({
			type: 'RecoveryStarted',
			commandId: snapshotCommand.commandId,
			generation: snapshotCommand.generation,
			snapshot: { remoteUserStreams: {}, externalStreams: {} },
		});

		if (rebuildCommand?.type !== 'RebuildTransports') {
			throw new Error('expected RebuildTransports command');
		}

		// The machine moved its active command on: the snapshot command is stale,
		// the rebuild command is current.
		expect(isVoiceSessionCommandCurrent(snapshotCommand)).toBe(false);
		expect(isVoiceSessionCommandCurrent(rebuildCommand)).toBe(true);

		// Leaving the recovery phase invalidates the rebuild command too.
		dispatchVoiceSession({ type: 'Terminated', reason: 'kicked', channelId: 5 });

		expect(isVoiceSessionCommandCurrent(rebuildCommand)).toBe(false);
	});

	it('never reports final commands as current', () => {
		const [snapshotCommand] = dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });

		if (snapshotCommand?.type !== 'CaptureRecoverySnapshot') {
			throw new Error('expected CaptureRecoverySnapshot command');
		}

		const [rebuildCommand] = dispatchVoiceSession({
			type: 'RecoveryStarted',
			commandId: snapshotCommand.commandId,
			generation: snapshotCommand.generation,
			snapshot: { remoteUserStreams: {}, externalStreams: {} },
		});

		if (rebuildCommand?.type !== 'RebuildTransports') {
			throw new Error('expected RebuildTransports command');
		}

		const [finalCommand] = dispatchVoiceSession({
			type: 'RebuildSucceeded',
			commandId: rebuildCommand.commandId,
			generation: rebuildCommand.generation,
		});

		if (finalCommand?.type !== 'RecoverDesktopAppAudio') {
			throw new Error('expected RecoverDesktopAppAudio command');
		}

		// Currency is a recovery-step concept (phase.activeCommandId): final
		// commands are emitted while leaving the recovery phase, so they are never
		// current even though their generation matches the connected phase.
		expect(isVoiceSessionCommandCurrent(finalCommand)).toBe(false);
	});

	it('notifies full listeners before delivering commands', () => {
		const order: string[] = [];
		const unsubscribe = subscribeVoiceSession(() => {
			order.push('listener');
		});
		const unregister = registerVoiceSessionCommandRunner(() => {
			order.push('runner');
		});

		dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });
		unsubscribe();
		unregister();

		expect(order).toEqual(['listener', 'runner']);
	});

	it('updates direct selectors from dispatch with no projection or listener involved', () => {
		// Direct selectors must be correct from the dispatch alone, without any
		// secondary store or synchronization listener.
		dispatchVoiceSession({
			type: 'WsDropped',
			pending: pendingReconnect,
			now: 111,
			online: true,
			authenticated: false,
		});

		expect(selectVoiceSessionState(selectPendingVoiceReconnect)).toEqual(pendingReconnect);
		expect(selectVoiceSessionState(selectReconnectingSince)).toBe(111);
		expect(selectVoiceSessionState(selectReconnectAuthenticated)).toBe(false);

		dispatchVoiceSession({ type: 'SocketAuthenticated' });

		expect(selectVoiceSessionState(selectReconnectAuthenticated)).toBe(true);

		const suppression = { channelId: 5, peerUserIds: [10], expiresAt: 20_000 };

		dispatchVoiceSession({ type: 'ReconnectSuppressionChanged', suppression });

		expect(selectVoiceSessionState(selectVoiceReconnectSuppression)).toEqual(suppression);
	});

	it('falls back to the facade mirror fields when not reconnecting', () => {
		dispatchVoiceSession({ type: 'ReconnectIntentCaptured', pending: pendingReconnect });

		expect(getVoiceSessionState().phase.phase).toBe('idle');
		expect(selectVoiceSessionState(selectPendingVoiceReconnect)).toEqual(pendingReconnect);
		expect(selectVoiceSessionState(selectReconnectingSince)).toBeUndefined();
		expect(selectVoiceSessionState(selectReconnectAuthenticated)).toBe(false);
	});

	it('notifies state-only listeners before command delivery without exposing commands', () => {
		const order: string[] = [];
		const unsubscribe = subscribeVoiceSessionState((state) => {
			order.push(`state:${state.phase.phase}`);
		});
		const unregister = registerVoiceSessionCommandRunner(() => {
			order.push('runner');
		});

		dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });
		unsubscribe();
		unregister();

		expect(order).toEqual(['state:rebuilding', 'runner']);
	});

	it('lets a command runner observe post-dispatch state through direct selectors', () => {
		// The WaitAuth command is emitted synchronously by the WsDropped dispatch.
		// A runner that reads the direct selectors when it receives the command
		// must see the post-dispatch reconnect. Observing pre-dispatch state here
		// would abort recovery as 'cleared'.
		let observed: { since: number | undefined; authenticated: boolean } | undefined;
		const unregister = registerVoiceSessionCommandRunner((commands) => {
			if (commands[0]?.type === 'WaitAuth') {
				observed = {
					since: selectVoiceSessionState(selectReconnectingSince),
					authenticated: selectVoiceSessionState(selectReconnectAuthenticated),
				};
			}
		});

		dispatchVoiceSession({ type: 'ReconnectIntentCaptured', pending: pendingReconnect });

		const [snapshotCommand] = dispatchVoiceSession({
			type: 'ReconnectStarted',
			now: 1234,
			online: true,
			authenticated: false,
		});

		if (snapshotCommand?.type !== 'CaptureRecoverySnapshot') {
			throw new Error('expected CaptureRecoverySnapshot command');
		}

		dispatchVoiceSession({
			type: 'RecoveryStarted',
			commandId: snapshotCommand.commandId,
			generation: snapshotCommand.generation,
			snapshot: { remoteUserStreams: {}, externalStreams: {} },
		});
		unregister();

		expect(observed).toEqual({ since: 1234, authenticated: false });
	});

	it('keeps command identity monotonic across reset so a stale identity can never recur', () => {
		const [firstSnapshot] = dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });

		if (firstSnapshot?.type !== 'CaptureRecoverySnapshot') {
			throw new Error('expected CaptureRecoverySnapshot command');
		}

		resetVoiceSessionState();

		// An identical post-reset sequence must mint strictly newer identities:
		// listeners (and pending executor operations) survive reset, so a repeated
		// generation/commandId pair could make a late operation read as current
		// again even when no executor listener is available to abort it.
		const [secondSnapshot] = dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });

		if (secondSnapshot?.type !== 'CaptureRecoverySnapshot') {
			throw new Error('expected CaptureRecoverySnapshot command');
		}

		expect(secondSnapshot.generation).toBeGreaterThan(firstSnapshot.generation);
		expect(secondSnapshot.commandId).toBeGreaterThan(firstSnapshot.commandId);
		expect(isVoiceSessionCommandCurrent(firstSnapshot)).toBe(false);
		expect(isVoiceSessionCommandCurrent(secondSnapshot)).toBe(true);
	});

	it('notifies state-only listeners on reset while dropping buffered commands', () => {
		const observedPhases: string[] = [];
		const unsubscribe = subscribeVoiceSessionState((state) => {
			observedPhases.push(state.phase.phase);
		});

		dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });
		resetVoiceSessionState();
		dispatchVoiceSession({ type: 'JoinRequested', channelId: 6 });
		unsubscribe();

		expect(observedPhases).toEqual(['rebuilding', 'idle', 'joining']);

		const executed: string[] = [];
		const unregister = registerVoiceSessionCommandRunner((commands) => {
			executed.push(...commands.map((command) => command.type));
		});

		unregister();
		expect(executed).toEqual([]);
	});
});
