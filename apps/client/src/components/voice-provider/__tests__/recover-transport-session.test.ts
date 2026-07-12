import { describe, expect, it } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import type { TPendingVoiceReconnect } from '@/features/server/voice/reconnect-coordinator';
import {
	createInitialVoiceSessionState,
	reduceVoiceSession,
	shouldFlushBufferedVoiceSessionCommand,
	type TVoiceSessionCommand,
	type TVoiceSessionState,
	type TWatchedRemoteStreamsSnapshot,
	VOICE_SESSION_REBUILD_MAX_ATTEMPTS,
	VOICE_SESSION_REBUILD_MAX_NONCE_RESTARTS,
} from '@/features/server/voice/voice-session-machine';

const watchedSnapshot = (): TWatchedRemoteStreamsSnapshot => ({
	remoteUserStreams: {
		10: [StreamKind.VIDEO],
		20: [StreamKind.SCREEN, StreamKind.SCREEN_AUDIO],
	},
	externalStreams: {
		99: { audio: true, video: true },
	},
});

const pendingReconnect = (): TPendingVoiceReconnect => ({
	channelId: 7,
	micMuted: false,
	soundMuted: false,
	peerUserIds: [10],
	expiresAt: 10_000,
});

const dispatch = (
	state: TVoiceSessionState,
	event: Parameters<typeof reduceVoiceSession>[1],
): [TVoiceSessionState, TVoiceSessionCommand[]] => {
	const result = reduceVoiceSession(state, event);

	return [result.state, result.commands];
};

const activeCommandId = (state: TVoiceSessionState): number => {
	const { phase } = state;

	if ((phase.phase !== 'rebuilding' && phase.phase !== 'reconnecting') || phase.activeCommandId === undefined) {
		throw new Error('expected active recovery command');
	}

	return phase.activeCommandId;
};

const startRebuild = (): [TVoiceSessionState, number, TWatchedRemoteStreamsSnapshot] => {
	let state = createInitialVoiceSessionState();
	let commands: TVoiceSessionCommand[];

	[state, commands] = dispatch(state, { type: 'TransportFailed', channelId: 7, nonce: 1 });

	expect(commands).toEqual([
		expect.objectContaining({
			type: 'CaptureRecoverySnapshot',
			recovery: 'rebuilding',
		}),
	]);

	const generation = commands[0]?.generation;
	if (generation === undefined) {
		throw new Error('expected rebuild generation');
	}

	const snapshot = watchedSnapshot();
	[state, commands] = dispatch(state, {
		type: 'RecoveryStarted',
		commandId: activeCommandId(state),
		generation,
		snapshot,
	});

	expect(commands).toEqual([
		expect.objectContaining({
			type: 'RebuildTransports',
			channelId: 7,
			nonce: 1,
			attempt: 0,
			generation,
			snapshot,
		}),
	]);

	return [state, generation, snapshot];
};

describe('transport rebuild machine orchestration', () => {
	it('captures watched streams once before issuing the first rebuild command', () => {
		const [state, generation, snapshot] = startRebuild();

		expect(state.phase).toMatchObject({
			phase: 'rebuilding',
			channelId: 7,
			nonce: 1,
			attempt: 0,
			nonceRestarts: 0,
			generation,
			snapshot,
		});
	});

	it('moves to connected and emits desktop app-audio recovery after rebuild success', () => {
		const [state, generation] = startRebuild();
		const result = reduceVoiceSession(state, {
			type: 'RebuildSucceeded',
			commandId: activeCommandId(state),
			generation,
		});

		expect(result.state.phase).toEqual({ phase: 'connected', channelId: 7, generation: expect.any(Number) });
		expect(result.commands).toEqual([
			expect.objectContaining({
				type: 'RecoverDesktopAppAudio',
				generation,
			}),
		]);
	});

	it('retries transient rebuild failures from reducer-owned attempt state', () => {
		const [state, generation, snapshot] = startRebuild();
		const result = reduceVoiceSession(state, {
			type: 'RebuildFailed',
			commandId: activeCommandId(state),
			generation,
			error: new Error('network blip'),
		});

		expect(result.state.phase).toMatchObject({
			phase: 'rebuilding',
			attempt: 1,
		});
		expect(result.commands).toEqual([
			expect.objectContaining({
				type: 'RebuildTransports',
				generation,
				channelId: 7,
				nonce: 1,
				attempt: 1,
				snapshot,
			}),
		]);
	});

	it('fails terminally with leave cleanup after rebuild attempts are exhausted', () => {
		let [state, generation] = startRebuild();
		let commands: TVoiceSessionCommand[] = [];

		for (let attempt = 0; attempt < VOICE_SESSION_REBUILD_MAX_ATTEMPTS; attempt += 1) {
			[state, commands] = dispatch(state, {
				type: 'RebuildFailed',
				commandId: activeCommandId(state),
				generation,
				error: new Error(`failure ${attempt}`),
			});
		}

		expect(state.phase).toEqual({
			phase: 'failed',
			reason: 'restore-terminal-error',
			channelId: 7,
			generation: expect.any(Number),
		});
		expect(commands).toEqual([
			expect.objectContaining({
				type: 'LeaveVoiceSession',
				generation: generation + 1,
				channelId: 7,
			}),
		]);
	});

	it('restarts rebuild commands when the session nonce changes', () => {
		let [state, generation, snapshot] = startRebuild();

		[state] = dispatch(state, {
			type: 'NonceChanged',
			commandId: activeCommandId(state),
			generation,
			nonce: 2,
		});

		expect(state.phase).toMatchObject({
			phase: 'rebuilding',
			nonce: 2,
			attempt: 0,
			nonceRestarts: 1,
			snapshot,
		});

		const result = reduceVoiceSession(state, {
			type: 'NonceChanged',
			commandId: activeCommandId(state),
			generation,
			nonce: 3,
		});
		expect(result.commands).toEqual([
			expect.objectContaining({
				type: 'RebuildTransports',
				generation,
				nonce: 3,
				attempt: 0,
				snapshot,
			}),
		]);
	});

	it('fails terminally with leave cleanup when nonce restarts exceed the cap', () => {
		let [state, generation] = startRebuild();
		let commands: TVoiceSessionCommand[] = [];

		for (let nonce = 2; nonce <= VOICE_SESSION_REBUILD_MAX_NONCE_RESTARTS + 2; nonce += 1) {
			[state, commands] = dispatch(state, {
				type: 'NonceChanged',
				commandId: activeCommandId(state),
				generation,
				nonce,
			});
		}

		expect(state.phase).toEqual({
			phase: 'failed',
			reason: 'restore-terminal-error',
			channelId: 7,
			generation: expect.any(Number),
		});
		expect(commands).toEqual([
			expect.objectContaining({
				type: 'LeaveVoiceSession',
				channelId: 7,
			}),
		]);
	});

	it('ignores transport failure while websocket reconnect owns recovery', () => {
		const [state, commands] = dispatch(createInitialVoiceSessionState(), {
			type: 'WsDropped',
			pending: pendingReconnect(),
			now: 100,
			online: true,
			authenticated: false,
		});

		expect(commands[0]).toEqual(expect.objectContaining({ type: 'CaptureRecoverySnapshot' }));
		const reconnectingState = state;
		const result = reduceVoiceSession(state, { type: 'TransportFailed', channelId: 7, nonce: 1 });

		expect(result.state).toBe(reconnectingState);
		expect(result.commands).toEqual([]);
	});

	it('preempts rebuilding when the websocket drops and drops stale rebuild results', () => {
		const [state, generation] = startRebuild();
		const rebuildCommandId = activeCommandId(state);
		const preempted = reduceVoiceSession(state, {
			type: 'WsDropped',
			pending: pendingReconnect(),
			now: 100,
			online: true,
			authenticated: false,
		});

		expect(preempted.state.phase).toMatchObject({
			phase: 'reconnecting',
			step: 'waitingAuth',
			pending: expect.objectContaining({ channelId: 7 }),
		});

		const staleResult = reduceVoiceSession(preempted.state, {
			type: 'RebuildSucceeded',
			commandId: rebuildCommandId,
			generation,
		});
		expect(staleResult.state).toBe(preempted.state);
		expect(staleResult.commands).toEqual([]);
	});
});

describe('shouldFlushBufferedVoiceSessionCommand', () => {
	const stateWithPhase = (phase: TVoiceSessionState['phase']): TVoiceSessionState => ({
		...createInitialVoiceSessionState(),
		phase,
	});

	it('flushes terminal commands only for the failed incarnation that emitted them', () => {
		const leaveCommand: TVoiceSessionCommand = {
			type: 'LeaveVoiceSession',
			commandId: 9,
			generation: 3,
			channelId: 7,
		};

		expect(
			shouldFlushBufferedVoiceSessionCommand(
				stateWithPhase({ phase: 'failed', reason: 'restore-terminal-error', channelId: 7, generation: 3 }),
				leaveCommand,
			),
		).toBe(true);
		// A later failure — even of the same channel — is a new incarnation.
		expect(
			shouldFlushBufferedVoiceSessionCommand(
				stateWithPhase({ phase: 'failed', reason: 'restore-terminal-error', channelId: 7, generation: 4 }),
				leaveCommand,
			),
		).toBe(false);
		// A failed phase without a generation (direct JoinFailed) owes nothing.
		expect(
			shouldFlushBufferedVoiceSessionCommand(
				stateWithPhase({ phase: 'failed', reason: 'restore-terminal-error', channelId: 7 }),
				leaveCommand,
			),
		).toBe(false);
		expect(shouldFlushBufferedVoiceSessionCommand(stateWithPhase({ phase: 'idle' }), leaveCommand)).toBe(false);
		expect(
			shouldFlushBufferedVoiceSessionCommand(
				stateWithPhase({ phase: 'connected', channelId: 7, generation: 3 }),
				leaveCommand,
			),
		).toBe(false);
	});

	it('flushes ClearFailedSession only for its own failed incarnation', () => {
		const clearCommand: TVoiceSessionCommand = {
			type: 'ClearFailedSession',
			commandId: 9,
			generation: 3,
			reason: 'restore-terminal-error',
			channelId: 7,
			leaveServerSession: true,
		};

		expect(
			shouldFlushBufferedVoiceSessionCommand(
				stateWithPhase({ phase: 'failed', reason: 'restore-terminal-error', channelId: 7, generation: 3 }),
				clearCommand,
			),
		).toBe(true);
		expect(
			shouldFlushBufferedVoiceSessionCommand(
				stateWithPhase({ phase: 'failed', reason: 'restore-terminal-error', channelId: 7, generation: 5 }),
				clearCommand,
			),
		).toBe(false);
		expect(shouldFlushBufferedVoiceSessionCommand(stateWithPhase({ phase: 'idle' }), clearCommand)).toBe(false);
	});

	it('flushes RecoverDesktopAppAudio only for the connected incarnation that owed it', () => {
		const recoverCommand: TVoiceSessionCommand = {
			type: 'RecoverDesktopAppAudio',
			commandId: 9,
			generation: 3,
		};

		expect(
			shouldFlushBufferedVoiceSessionCommand(
				stateWithPhase({ phase: 'connected', channelId: 7, generation: 3 }),
				recoverCommand,
			),
		).toBe(true);
		expect(
			shouldFlushBufferedVoiceSessionCommand(
				stateWithPhase({ phase: 'connected', channelId: 7, generation: 4 }),
				recoverCommand,
			),
		).toBe(false);
		// A plain join's connected phase carries no generation — a buffered
		// recovery from an earlier session must not publish stale intent into it.
		expect(
			shouldFlushBufferedVoiceSessionCommand(stateWithPhase({ phase: 'connected', channelId: 7 }), recoverCommand),
		).toBe(false);
		expect(shouldFlushBufferedVoiceSessionCommand(stateWithPhase({ phase: 'idle' }), recoverCommand)).toBe(false);
	});

	it('never flushes recovery-step commands — Resumed re-issues them', () => {
		const rebuildCommand: TVoiceSessionCommand = {
			type: 'RebuildTransports',
			commandId: 2,
			generation: 1,
			channelId: 7,
			nonce: 1,
			attempt: 0,
			snapshot: watchedSnapshot(),
		};

		expect(
			shouldFlushBufferedVoiceSessionCommand(
				stateWithPhase({
					phase: 'rebuilding',
					channelId: 7,
					nonce: 1,
					attempt: 0,
					nonceRestarts: 0,
					consecutiveUnknownErrors: 0,
					generation: 1,
					activeCommandId: 2,
					snapshot: watchedSnapshot(),
				}),
				rebuildCommand,
			),
		).toBe(false);
	});
});
