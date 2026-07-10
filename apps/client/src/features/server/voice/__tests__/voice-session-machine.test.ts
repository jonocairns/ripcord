import { describe, expect, it } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import type { TPendingVoiceReconnect } from '../reconnect-coordinator';
import {
	createInitialVoiceSessionState,
	reduceVoiceSession,
	selectVoiceSessionConnectionStatus,
	type TVoiceSessionCommand,
	type TVoiceSessionState,
	type TWatchedRemoteStreamsSnapshot,
	VOICE_RECONNECT_SUPPRESSION_MS,
	VOICE_SESSION_REBUILD_MAX_NONCE_RESTARTS,
	voiceSessionResultState,
} from '../voice-session-machine';

const pending = (overrides: Partial<TPendingVoiceReconnect> = {}): TPendingVoiceReconnect => ({
	channelId: 5,
	micMuted: false,
	soundMuted: false,
	peerUserIds: [10, 20],
	expiresAt: 10_000,
	...overrides,
});

const snapshot = (): TWatchedRemoteStreamsSnapshot => ({
	remoteUserStreams: {
		10: [StreamKind.VIDEO],
		20: [StreamKind.SCREEN, StreamKind.SCREEN_AUDIO],
	},
	externalStreams: {
		99: { audio: true, video: false },
	},
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

const startRebuildWithSnapshot = (): [TVoiceSessionState, number] => {
	let state = createInitialVoiceSessionState();
	let commands: TVoiceSessionCommand[];

	[state, commands] = dispatch(state, { type: 'TransportFailed', channelId: 5, nonce: 1 });
	expect(commands).toEqual([
		expect.objectContaining({
			type: 'CaptureRecoverySnapshot',
			recovery: 'rebuilding',
		}),
	]);

	const generation = commands[0]?.generation;
	expect(typeof generation).toBe('number');
	if (generation === undefined) {
		throw new Error('expected rebuild generation');
	}

	[state, commands] = dispatch(state, {
		type: 'RecoveryStarted',
		commandId: activeCommandId(state),
		generation,
		snapshot: snapshot(),
	});
	expect(commands).toEqual([expect.objectContaining({ type: 'RebuildTransports', generation })]);

	return [state, generation];
};

const startReconnectWithSnapshot = (authenticated = true): [TVoiceSessionState, number] => {
	let state = createInitialVoiceSessionState();
	let commands: TVoiceSessionCommand[];

	[state, commands] = dispatch(state, {
		type: 'WsDropped',
		pending: pending(),
		now: 100,
		online: true,
		authenticated,
	});
	expect(commands[0]).toEqual(expect.objectContaining({ type: 'CaptureRecoverySnapshot' }));

	const generation = commands[0]?.generation;
	expect(typeof generation).toBe('number');
	if (generation === undefined) {
		throw new Error('expected reconnect generation');
	}

	[state, commands] = dispatch(state, {
		type: 'RecoveryStarted',
		commandId: activeCommandId(state),
		generation,
		snapshot: snapshot(),
	});

	if (authenticated) {
		expect(commands[0]).toEqual(expect.objectContaining({ type: 'RestoreVoiceSession' }));
	} else {
		expect(commands[0]).toEqual(expect.objectContaining({ type: 'WaitAuth' }));
	}

	return [state, generation];
};

describe('voice session machine', () => {
	it('projects connection status from phase', () => {
		let state = createInitialVoiceSessionState();

		expect(selectVoiceSessionConnectionStatus(state)).toBe('disconnected');

		state = voiceSessionResultState(reduceVoiceSession(state, { type: 'JoinRequested', channelId: 5 }));
		expect(selectVoiceSessionConnectionStatus(state)).toBe('connecting');

		state = voiceSessionResultState(reduceVoiceSession(state, { type: 'JoinSucceeded', channelId: 5 }));
		expect(selectVoiceSessionConnectionStatus(state)).toBe('connected');

		state = voiceSessionResultState(reduceVoiceSession(state, { type: 'Terminated', reason: 'kicked', channelId: 5 }));
		expect(selectVoiceSessionConnectionStatus(state)).toBe('failed');
	});

	it('defers transport failure while ws reconnect owns recovery', () => {
		const [reconnectingState] = startReconnectWithSnapshot(false);
		const result = reduceVoiceSession(reconnectingState, { type: 'TransportFailed', channelId: 5, nonce: 1 });

		expect(result.state).toBe(reconnectingState);
		expect(result.commands).toEqual([]);
	});

	it('preempts in-session rebuild when the websocket drops', () => {
		const [rebuildingState, rebuildGeneration] = startRebuildWithSnapshot();
		const result = reduceVoiceSession(rebuildingState, {
			type: 'WsDropped',
			pending: pending({ channelId: 5 }),
			now: 200,
			online: true,
			authenticated: false,
		});

		expect(result.state.phase).toMatchObject({
			phase: 'reconnecting',
			step: 'waitingAuth',
			pending: expect.objectContaining({ channelId: 5 }),
		});
		expect(result.state.phase).not.toMatchObject({ phase: 'rebuilding' });
		expect(result.commands[0]).toEqual(
			expect.objectContaining({
				type: 'CaptureRecoverySnapshot',
				recovery: 'reconnecting',
			}),
		);
		expect(result.commands[0]?.generation).not.toBe(rebuildGeneration);
	});

	it('drops stale result events by generation', () => {
		const [rebuildingState, generation] = startRebuildWithSnapshot();
		const result = reduceVoiceSession(rebuildingState, {
			type: 'RebuildSucceeded',
			commandId: activeCommandId(rebuildingState),
			generation: generation + 1,
		});

		expect(result.state).toBe(rebuildingState);
		expect(result.commands).toEqual([]);
	});

	it('restarts rebuild attempts on nonce changes until the cap is exceeded', () => {
		let [state, generation] = startRebuildWithSnapshot();

		for (let nonce = 2; nonce <= VOICE_SESSION_REBUILD_MAX_NONCE_RESTARTS + 1; nonce += 1) {
			const result = reduceVoiceSession(state, {
				type: 'NonceChanged',
				commandId: activeCommandId(state),
				generation,
				nonce,
			});

			expect(result.state.phase).toMatchObject({
				phase: 'rebuilding',
				nonce,
				nonceRestarts: nonce - 1,
				attempt: 0,
			});
			expect(result.commands[0]).toEqual(
				expect.objectContaining({
					type: 'RebuildTransports',
					generation,
					nonce,
					attempt: 0,
				}),
			);

			state = result.state;
		}

		const capped = reduceVoiceSession(state, {
			type: 'NonceChanged',
			commandId: activeCommandId(state),
			generation,
			nonce: VOICE_SESSION_REBUILD_MAX_NONCE_RESTARTS + 2,
		});

		expect(capped.state.phase).toEqual({ phase: 'failed', reason: 'restore-terminal-error', channelId: 5 });
		// The abandoned rebuild left transports torn down, so the cap must emit the
		// same leave/teardown command as an exhausted-attempts failure.
		expect(capped.commands).toEqual([
			expect.objectContaining({ type: 'LeaveVoiceSession', generation: generation + 1, channelId: 5 }),
		]);
	});

	it('retries reconnect failures and tracks unknown error count in reducer state', () => {
		const [state, generation] = startReconnectWithSnapshot(true);
		const result = reduceVoiceSession(state, {
			type: 'RestoreFailed',
			commandId: activeCommandId(state),
			generation,
			error: new Error('mystery'),
		});

		expect(result.state.phase).toMatchObject({
			phase: 'reconnecting',
			step: 'retryDelay',
			retryAttempt: 1,
			consecutiveUnknownErrors: 1,
		});
		expect(result.commands[0]).toEqual(
			expect.objectContaining({
				type: 'RetryDelay',
				generation,
				attempt: 0,
				expiresAt: 10_000,
			}),
		);
	});

	it('enters waitingOnline when reconnect starts offline', () => {
		let state = createInitialVoiceSessionState();
		let commands: TVoiceSessionCommand[];

		[state, commands] = dispatch(state, {
			type: 'WsDropped',
			pending: pending(),
			now: 100,
			online: false,
			authenticated: false,
		});
		expect(commands[0]).toEqual(expect.objectContaining({ type: 'CaptureRecoverySnapshot' }));

		const generation = commands[0]?.generation;
		expect(typeof generation).toBe('number');
		if (generation === undefined) {
			throw new Error('expected reconnect generation');
		}

		[state, commands] = dispatch(state, {
			type: 'RecoveryStarted',
			commandId: activeCommandId(state),
			generation,
			snapshot: snapshot(),
		});

		expect(state.phase).toMatchObject({ phase: 'reconnecting', step: 'waitingOnline' });
		expect(commands).toEqual([expect.objectContaining({ type: 'WaitOnline', generation, expiresAt: 10_000 })]);

		const expired = reduceVoiceSession(state, {
			type: 'OnlineExpired',
			commandId: activeCommandId(state),
			generation,
		});

		expect(expired.state.phase).toEqual({ phase: 'failed', reason: 'reconnect-expired', channelId: 5 });
		expect(expired.commands).toEqual([
			expect.objectContaining({
				type: 'ClearFailedSession',
				reason: 'reconnect-expired',
				channelId: 5,
				leaveServerSession: false,
			}),
		]);
	});

	it('does not skip the online gate when authentication arrives while waitingOnline', () => {
		let state = createInitialVoiceSessionState();
		let commands: TVoiceSessionCommand[];

		[state, commands] = dispatch(state, {
			type: 'WsDropped',
			pending: pending(),
			now: 100,
			online: false,
			authenticated: false,
		});

		const generation = commands[0]?.generation;
		expect(typeof generation).toBe('number');
		if (generation === undefined) {
			throw new Error('expected reconnect generation');
		}

		[state] = dispatch(state, {
			type: 'RecoveryStarted',
			commandId: activeCommandId(state),
			generation,
			snapshot: snapshot(),
		});
		expect(state.phase).toMatchObject({ phase: 'reconnecting', step: 'waitingOnline', authenticated: false });

		[state, commands] = dispatch(state, { type: 'SocketAuthenticated' });

		expect(state.phase).toMatchObject({ phase: 'reconnecting', step: 'waitingOnline', authenticated: true });
		expect(commands).toEqual([]);

		[state, commands] = dispatch(state, {
			type: 'OnlineReady',
			commandId: activeCommandId(state),
			generation,
		});

		expect(state.phase).toMatchObject({ phase: 'reconnecting', step: 'restoring', authenticated: true });
		expect(commands).toEqual([expect.objectContaining({ type: 'RestoreVoiceSession', generation })]);
	});

	it('invalidates an in-flight restore when the websocket drops again', () => {
		const [state, generation] = startReconnectWithSnapshot(true);
		if (state.phase.phase !== 'reconnecting') {
			throw new Error('expected reconnecting phase');
		}

		const previousPhase = state.phase;
		const previousSnapshot = state.phase.snapshot;
		const restoreCommandId = activeCommandId(state);
		const result = reduceVoiceSession(state, {
			type: 'WsDropped',
			pending: pending({ expiresAt: 20_000 }),
			now: 200,
			online: false,
			authenticated: false,
		});

		expect(result.commands).toEqual([
			expect.objectContaining({
				type: 'WaitOnline',
				generation,
			}),
		]);
		if (result.state.phase.phase !== 'reconnecting') {
			throw new Error('expected reconnecting phase after repeated drop');
		}

		expect(result.state.phase).toMatchObject({
			phase: 'reconnecting',
			step: 'waitingOnline',
			authenticated: false,
			generation,
			pending: expect.objectContaining({ expiresAt: 20_000 }),
		});
		expect(result.state.phase.activeCommandId).not.toBe(restoreCommandId);
		expect(result.state.phase.snapshot).toBe(previousSnapshot);
		expect(result.state.phase.retryAttempt).toBe(previousPhase.retryAttempt);
		expect(result.state.phase.consecutiveUnknownErrors).toBe(previousPhase.consecutiveUnknownErrors);

		const staleRestore = reduceVoiceSession(result.state, {
			type: 'RestoreSucceeded',
			commandId: restoreCommandId,
			generation,
			serverSessionEstablished: true,
		});
		expect(staleRestore.state).toBe(result.state);
		expect(staleRestore.commands).toEqual([]);
	});

	it('moves an in-flight restore back behind the auth gate when the socket becomes unauthenticated', () => {
		const [state, generation] = startReconnectWithSnapshot(true);
		const restoreCommandId = activeCommandId(state);
		const result = reduceVoiceSession(state, { type: 'SocketUnauthenticated' });

		expect(result.state.phase).toMatchObject({
			phase: 'reconnecting',
			step: 'waitingAuth',
			authenticated: false,
			generation,
		});
		expect(result.commands).toEqual([expect.objectContaining({ type: 'WaitAuth', generation })]);
		expect(activeCommandId(result.state)).not.toBe(restoreCommandId);

		const staleRestore = reduceVoiceSession(result.state, {
			type: 'RestoreSucceeded',
			commandId: restoreCommandId,
			generation,
			serverSessionEstablished: true,
		});
		expect(staleRestore.state).toBe(result.state);
		expect(staleRestore.commands).toEqual([]);
	});

	it('uses the shared classifier for rebuild terminal failures and emits leave cleanup', () => {
		const [state, generation] = startRebuildWithSnapshot();
		const result = reduceVoiceSession(state, {
			type: 'RebuildFailed',
			commandId: activeCommandId(state),
			generation,
			error: {
				data: {
					code: 'CONFLICT',
					httpStatus: 409,
				},
			},
		});

		expect(result.state.phase).toEqual({ phase: 'failed', reason: 'restore-conflict', channelId: 5 });
		expect(result.commands).toEqual([
			expect.objectContaining({ type: 'LeaveVoiceSession', generation: generation + 1, channelId: 5 }),
		]);
	});

	it('turns classifier terminal reconnect failures into failed state and cleanup commands', () => {
		const [state, generation] = startReconnectWithSnapshot(true);
		const result = reduceVoiceSession(state, {
			type: 'RestoreFailed',
			commandId: activeCommandId(state),
			generation,
			serverSessionEstablished: true,
			error: {
				data: {
					code: 'CONFLICT',
					httpStatus: 409,
				},
			},
		});

		expect(result.state.phase).toEqual({ phase: 'failed', reason: 'restore-conflict', channelId: 5 });
		expect(result.state.pendingVoiceReconnect).toBeUndefined();
		expect(result.state.reconnectingSince).toBeUndefined();
		expect(result.state.reconnectAuthenticated).toBe(false);
		// The give-up path must run the full reconnect clear (Sentry report, reason
		// toast, clearVoiceReconnectRecovery) AND leave the server session that
		// restoreOrJoin already bound this cycle.
		expect(result.commands).toEqual([
			expect.objectContaining({
				type: 'ClearFailedSession',
				generation: generation + 1,
				reason: 'restore-conflict',
				channelId: 5,
				leaveServerSession: true,
			}),
		]);
	});

	it('clears without a server leave when the terminal reconnect failure never established a session', () => {
		const [state, generation] = startReconnectWithSnapshot(true);
		const result = reduceVoiceSession(state, {
			type: 'RestoreFailed',
			commandId: activeCommandId(state),
			generation,
			serverSessionEstablished: false,
			error: {
				data: {
					code: 'CONFLICT',
					httpStatus: 409,
				},
			},
		});

		expect(result.state.phase).toEqual({ phase: 'failed', reason: 'restore-conflict', channelId: 5 });
		expect(result.commands).toEqual([
			expect.objectContaining({
				type: 'ClearFailedSession',
				reason: 'restore-conflict',
				channelId: 5,
				leaveServerSession: false,
			}),
		]);
	});

	it('keeps server-session ownership sticky when a later retry fails before restoring', () => {
		let [state, generation] = startReconnectWithSnapshot(true);
		let commands: TVoiceSessionCommand[];

		[state, commands] = dispatch(state, {
			type: 'RestoreFailed',
			commandId: activeCommandId(state),
			generation,
			serverSessionEstablished: true,
			error: {
				data: {
					code: 'INTERNAL_SERVER_ERROR',
					httpStatus: 500,
				},
			},
		});

		expect(state.phase).toMatchObject({
			phase: 'reconnecting',
			step: 'retryDelay',
			serverSessionEstablished: true,
		});
		expect(commands).toEqual([expect.objectContaining({ type: 'RetryDelay' })]);

		[state, commands] = dispatch(state, {
			type: 'RetryDelayElapsed',
			commandId: activeCommandId(state),
			generation,
		});
		expect(commands).toEqual([expect.objectContaining({ type: 'RestoreVoiceSession' })]);

		[state, commands] = dispatch(state, {
			type: 'RestoreFailed',
			commandId: activeCommandId(state),
			generation,
			serverSessionEstablished: false,
			error: {
				data: {
					code: 'CONFLICT',
					httpStatus: 409,
				},
			},
		});

		expect(state.phase).toEqual({ phase: 'failed', reason: 'restore-conflict', channelId: 5 });
		expect(commands).toEqual([
			expect.objectContaining({
				type: 'ClearFailedSession',
				leaveServerSession: true,
			}),
		]);
	});

	it('leaves a previously established server session when the retry window expires', () => {
		let [state, generation] = startReconnectWithSnapshot(true);
		let commands: TVoiceSessionCommand[];

		[state, commands] = dispatch(state, {
			type: 'RestoreFailed',
			commandId: activeCommandId(state),
			generation,
			serverSessionEstablished: true,
			error: new Error('network connection lost'),
		});
		expect(commands).toEqual([expect.objectContaining({ type: 'RetryDelay' })]);

		[state, commands] = dispatch(state, {
			type: 'RetryDelayExpired',
			commandId: activeCommandId(state),
			generation,
		});

		expect(state.phase).toEqual({ phase: 'failed', reason: 'reconnect-expired', channelId: 5 });
		expect(commands).toEqual([
			expect.objectContaining({
				type: 'ClearFailedSession',
				leaveServerSession: true,
			}),
		]);
	});

	it('emits ledger restore and completes reconnect without duplicate desktop app-audio recovery', () => {
		let [state, generation] = startReconnectWithSnapshot(true);
		let commands: TVoiceSessionCommand[];

		[state, commands] = dispatch(state, {
			type: 'RestoreSucceeded',
			commandId: activeCommandId(state),
			generation,
			serverSessionEstablished: true,
		});

		expect(state.phase).toMatchObject({ phase: 'reconnecting', step: 'restoreWatch' });
		expect(commands).toEqual([expect.objectContaining({ type: 'RestoreWatchIntent', generation })]);

		const restoredAt = 50_000;

		[state, commands] = dispatch(state, {
			type: 'WatchIntentRehydrated',
			commandId: activeCommandId(state),
			generation,
			now: restoredAt,
		});

		expect(state.phase).toEqual({ phase: 'connected', channelId: 5 });
		expect(state.pendingVoiceReconnect).toBeUndefined();
		expect(state.reconnectingSince).toBeUndefined();
		expect(state.reconnectAuthenticated).toBe(false);
		expect(state.suppression).toEqual({
			channelId: 5,
			peerUserIds: [10, 20],
			expiresAt: restoredAt + VOICE_RECONNECT_SUPPRESSION_MS,
		});
		expect(commands).toEqual([]);
	});

	it('waits for auth before restore when reconnect starts unauthenticated', () => {
		let [state, generation] = startReconnectWithSnapshot(false);
		let commands: TVoiceSessionCommand[];

		[state, commands] = dispatch(state, { type: 'SocketAuthenticated' });

		expect(state.phase).toMatchObject({ phase: 'reconnecting', authenticated: true, step: 'waitingAuth' });
		expect(commands).toEqual([]);

		const authReadyResult = dispatch(state, {
			type: 'AuthReady',
			commandId: activeCommandId(state),
			generation,
		});
		commands = authReadyResult[1];
		state = authReadyResult[0];

		expect(state.phase).toMatchObject({ phase: 'reconnecting', authenticated: true, step: 'restoring' });
		expect(commands).toEqual([expect.objectContaining({ type: 'RestoreVoiceSession', generation })]);
	});

	it('clears reconnect facade fields when auth recovery is cleared', () => {
		const [state, generation] = startReconnectWithSnapshot(false);
		const result = reduceVoiceSession(state, {
			type: 'AuthCleared',
			commandId: activeCommandId(state),
			generation,
		});

		expect(result.state.phase).toEqual({ phase: 'idle' });
		expect(result.state.pendingVoiceReconnect).toBeUndefined();
		expect(result.state.reconnectingSince).toBeUndefined();
		expect(result.state.reconnectAuthenticated).toBe(false);
		expect(result.commands).toEqual([]);
	});

	it('resumes an interrupted rebuild under a new generation and drops the old instance results', () => {
		const [state, generation] = startRebuildWithSnapshot();
		const resumed = reduceVoiceSession(state, { type: 'Resumed' });

		expect(resumed.state.phase).toMatchObject({ phase: 'rebuilding', generation: generation + 1 });
		expect(resumed.commands).toEqual([
			expect.objectContaining({
				type: 'RebuildTransports',
				generation: generation + 1,
				channelId: 5,
				attempt: 0,
				snapshot: snapshot(),
			}),
		]);

		// A runner still in flight from before the resume reports under the old
		// generation and must be ignored.
		const stale = reduceVoiceSession(resumed.state, {
			type: 'RebuildSucceeded',
			commandId: activeCommandId(state),
			generation,
		});
		expect(stale.state).toBe(resumed.state);
		expect(stale.commands).toEqual([]);
	});

	it('resumes an interrupted reconnect retry delay under a new generation', () => {
		let [state, generation] = startReconnectWithSnapshot(true);

		[state] = dispatch(state, {
			type: 'RestoreFailed',
			commandId: activeCommandId(state),
			generation,
			error: new Error('blip'),
		});
		expect(state.phase).toMatchObject({ phase: 'reconnecting', step: 'retryDelay', retryAttempt: 1 });

		const resumed = reduceVoiceSession(state, { type: 'Resumed' });

		expect(resumed.state.phase).toMatchObject({
			phase: 'reconnecting',
			step: 'retryDelay',
			generation: generation + 1,
		});
		expect(resumed.commands).toEqual([
			expect.objectContaining({
				type: 'RetryDelay',
				generation: generation + 1,
				attempt: 0,
				expiresAt: 10_000,
			}),
		]);
	});

	it('ignores resume outside recovery phases', () => {
		const state = createInitialVoiceSessionState();
		const result = reduceVoiceSession(state, { type: 'Resumed' });

		expect(result.state).toBe(state);
		expect(result.commands).toEqual([]);
	});
});
