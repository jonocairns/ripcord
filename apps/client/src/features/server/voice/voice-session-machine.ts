import type { StreamKind } from '@sharkord/shared';
import type { TClearReason, TPendingVoiceReconnect, TVoiceReconnectSuppression } from './reconnect-coordinator';
import { classifyVoiceReconnectError } from './reconnect-policy';

const VOICE_SESSION_REBUILD_MAX_ATTEMPTS = 3;
const VOICE_SESSION_REBUILD_MAX_NONCE_RESTARTS = 5;
const VOICE_RECONNECT_SUPPRESSION_MS = 10_000;

type TWatchedExternalStreamsSnapshot = {
	audio: boolean;
	video: boolean;
};

type TWatchedRemoteStreamsSnapshot = {
	remoteUserStreams: Record<number, StreamKind[]>;
	externalStreams: Record<number, TWatchedExternalStreamsSnapshot>;
};

// `generation` identifies the connected/recovering session incarnation.
// Buffered-command flushing and transport-failure proposals match on it so a
// result from one incarnation can never advance or finalize a later session —
// even a rejoin of the same channel, which gets a fresh generation.
type TVoiceSessionPhase =
	| { phase: 'idle' }
	| { phase: 'joining'; channelId: number }
	| { phase: 'connected'; channelId: number; generation: number }
	| {
			phase: 'rebuilding';
			channelId: number;
			nonce: number;
			attempt: number;
			nonceRestarts: number;
			consecutiveUnknownErrors: number;
			generation: number;
			activeCommandId?: number;
			snapshot?: TWatchedRemoteStreamsSnapshot;
	  }
	| {
			phase: 'reconnecting';
			step: 'waitingOnline' | 'waitingAuth' | 'restoring' | 'restoreWatch' | 'retryDelay';
			reconnectingSince: number;
			authenticated: boolean;
			pending: TPendingVoiceReconnect;
			retryAttempt: number;
			consecutiveUnknownErrors: number;
			generation: number;
			activeCommandId?: number;
			snapshot?: TWatchedRemoteStreamsSnapshot;
			serverSessionEstablished?: boolean;
	  }
	| { phase: 'failed'; reason: TClearReason; channelId?: number; generation?: number };

type TVoiceSessionState = {
	phase: TVoiceSessionPhase;
	pendingVoiceReconnect?: TPendingVoiceReconnect;
	reconnectingSince?: number;
	suppression?: TVoiceReconnectSuppression;
	reconnectAuthenticated: boolean;
	nextGeneration: number;
	nextCommandId: number;
};

type TVoiceSessionConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';

type TRecoveryKind = 'rebuilding' | 'reconnecting';

type TVoiceSessionCommand =
	| { type: 'CaptureRecoverySnapshot'; commandId: number; generation: number; recovery: TRecoveryKind }
	| {
			type: 'RebuildTransports';
			commandId: number;
			generation: number;
			channelId: number;
			nonce: number;
			attempt: number;
			snapshot: TWatchedRemoteStreamsSnapshot;
	  }
	| { type: 'WaitOnline'; commandId: number; generation: number; expiresAt: number }
	| { type: 'WaitAuth'; commandId: number; generation: number; expiresAt: number }
	| {
			type: 'RestoreVoiceSession';
			commandId: number;
			generation: number;
			pending: TPendingVoiceReconnect;
			attempt: number;
			snapshot: TWatchedRemoteStreamsSnapshot;
	  }
	| {
			type: 'RetryDelay';
			commandId: number;
			generation: number;
			attempt: number;
			expiresAt: number;
	  }
	| {
			type: 'RestoreWatchIntent';
			commandId: number;
			generation: number;
			snapshot: TWatchedRemoteStreamsSnapshot;
	  }
	| { type: 'RecoverDesktopAppAudio'; commandId: number; generation: number }
	| { type: 'LeaveVoiceSession'; commandId: number; generation: number; channelId?: number }
	| {
			type: 'ClearFailedSession';
			commandId: number;
			generation: number;
			reason: TClearReason;
			channelId?: number;
			// True when the failed recovery already bound a server-side session
			// (restoreOrJoin succeeded this cycle); the runner must send voice.leave
			// so the server does not keep the user resident in the channel.
			leaveServerSession: boolean;
	  };

type TVoiceSessionCommandInput = TVoiceSessionCommand extends infer Command
	? Command extends TVoiceSessionCommand
		? Omit<Command, 'commandId'>
		: never
	: never;

type TVoiceSessionTriggerEvent =
	| { type: 'JoinRequested'; channelId: number }
	| { type: 'JoinSucceeded'; channelId: number }
	| { type: 'JoinFailed'; reason: TClearReason; channelId?: number }
	| { type: 'WsDropped'; pending: TPendingVoiceReconnect; now: number; online: boolean; authenticated: boolean }
	| { type: 'TransportFailed'; channelId: number; nonce: number; connectedGeneration?: number }
	| { type: 'TransportRecoveryExhausted'; channelId: number; connectedGeneration?: number }
	| { type: 'SocketAuthenticated' }
	| { type: 'SocketUnauthenticated' }
	| { type: 'NonceChanged'; commandId: number; generation: number; nonce: number }
	| { type: 'Terminated'; reason: TClearReason; channelId?: number }
	| { type: 'ReconnectIntentCaptured'; pending: TPendingVoiceReconnect }
	| { type: 'ReconnectStarted'; now: number; online: boolean; authenticated: boolean }
	| { type: 'ReconnectStartCleared' }
	| { type: 'RecoveryCleared'; reason: TClearReason }
	| { type: 'ReconnectSuppressionChanged'; suppression: TVoiceReconnectSuppression | undefined }
	| { type: 'Resumed' };

type TVoiceSessionResultEvent =
	| { type: 'RecoveryStarted'; commandId: number; generation: number; snapshot: TWatchedRemoteStreamsSnapshot }
	| { type: 'RebuildSucceeded'; commandId: number; generation: number; now: number }
	| { type: 'RebuildFailed'; commandId: number; generation: number; error: unknown }
	| { type: 'RestoreSucceeded'; commandId: number; generation: number; serverSessionEstablished?: boolean }
	| { type: 'RestoreFailed'; commandId: number; generation: number; error: unknown; serverSessionEstablished?: boolean }
	| { type: 'OnlineReady'; commandId: number; generation: number }
	| { type: 'OnlineExpired'; commandId: number; generation: number }
	| { type: 'AuthReady'; commandId: number; generation: number }
	| { type: 'AuthExpired'; commandId: number; generation: number }
	| { type: 'AuthCleared'; commandId: number; generation: number }
	| { type: 'RetryDelayElapsed'; commandId: number; generation: number }
	| { type: 'RetryDelayExpired'; commandId: number; generation: number }
	| { type: 'WatchIntentRehydrated'; commandId: number; generation: number; now: number };

type TVoiceSessionEvent = TVoiceSessionTriggerEvent | TVoiceSessionResultEvent;

type TVoiceSessionReducerResult = {
	state: TVoiceSessionState;
	commands: TVoiceSessionCommand[];
	transportRecoveryTransition?: TTransportRecoveryTransition;
};

type TTransportRecoveryTransition =
	| { type: 'failure-accepted'; channelId: number; connectedGeneration?: number; recoveryGeneration: number }
	| { type: 'exhaustion-accepted'; channelId: number; connectedGeneration?: number }
	| { type: 'rebuild-succeeded'; channelId: number; generation: number; now: number }
	| { type: 'reconnect-succeeded'; channelId: number; generation: number; now: number };

const createInitialVoiceSessionState = (): TVoiceSessionState => ({
	phase: { phase: 'idle' },
	reconnectAuthenticated: false,
	nextGeneration: 1,
	nextCommandId: 1,
});

const voiceSessionResultState = (result: TVoiceSessionReducerResult): TVoiceSessionState => result.state;

const emptyResult = (state: TVoiceSessionState): TVoiceSessionReducerResult => ({
	state,
	commands: [],
});

const addCommandId = (command: TVoiceSessionCommandInput, commandId: number): TVoiceSessionCommand => {
	switch (command.type) {
		case 'CaptureRecoverySnapshot':
			return { ...command, commandId };
		case 'RebuildTransports':
			return { ...command, commandId };
		case 'WaitOnline':
			return { ...command, commandId };
		case 'WaitAuth':
			return { ...command, commandId };
		case 'RestoreVoiceSession':
			return { ...command, commandId };
		case 'RetryDelay':
			return { ...command, commandId };
		case 'RestoreWatchIntent':
			return { ...command, commandId };
		case 'RecoverDesktopAppAudio':
			return { ...command, commandId };
		case 'LeaveVoiceSession':
			return { ...command, commandId };
		case 'ClearFailedSession':
			return { ...command, commandId };
	}
};

const withCommand = (state: TVoiceSessionState, command: TVoiceSessionCommandInput): TVoiceSessionReducerResult => {
	const commandId = state.nextCommandId;
	const phase = state.phase;
	const nextPhase =
		(phase.phase === 'rebuilding' || phase.phase === 'reconnecting') && phase.generation === command.generation
			? { ...phase, activeCommandId: commandId }
			: phase;

	return {
		state: {
			...state,
			phase: nextPhase,
			nextCommandId: commandId + 1,
		},
		commands: [addCommandId(command, commandId)],
	};
};

const nextGeneration = (state: TVoiceSessionState): [TVoiceSessionState, number] => {
	const generation = state.nextGeneration;

	return [{ ...state, nextGeneration: generation + 1 }, generation];
};

// Resets the facade mirror only; keep phase intact for callers that still need phase data while exiting recovery.
const clearReconnectFacadeRecovery = (state: TVoiceSessionState): TVoiceSessionState => ({
	...state,
	pendingVoiceReconnect: undefined,
	reconnectingSince: undefined,
	reconnectAuthenticated: false,
});

// 'leave' — in-session rebuild gave up: send voice.leave and tear down locally.
// 'clear' — run the reconnect give-up path (Sentry report, reason toast,
//   clearVoiceReconnectRecovery) without touching the server.
// 'leave-and-clear' — 'clear' plus an explicit voice.leave. Terminal reconnect
//   give-ups always use this: even when restoreOrJoin never succeeded,
//   joinServer may have adopted the pre-drop seat onto this connection, and
//   the server-side incarnation guard no-ops the leave when the seat belongs
//   to a newer session.
const failSession = (
	state: TVoiceSessionState,
	reason: TClearReason,
	channelId?: number,
	command?: 'leave' | 'clear' | 'leave-and-clear',
): TVoiceSessionReducerResult => {
	const [baseState, generation] = nextGeneration(state);
	const failedState: TVoiceSessionState = {
		...clearReconnectFacadeRecovery(baseState),
		phase: { phase: 'failed', reason, channelId, generation },
	};

	if (command === 'leave') {
		return withCommand(failedState, { type: 'LeaveVoiceSession', generation, channelId });
	}

	if (command === 'clear' || command === 'leave-and-clear') {
		return withCommand(failedState, {
			type: 'ClearFailedSession',
			generation,
			reason,
			channelId,
			leaveServerSession: command === 'leave-and-clear',
		});
	}

	return emptyResult(failedState);
};

// Exported so the store can expose live command currency and runners never
// duplicate the phase/generation/activeCommandId predicate.
const isCurrentVoiceSessionCommand = (
	state: TVoiceSessionState,
	command: { commandId: number; generation: number },
): boolean => {
	const { phase } = state;

	return (
		(phase.phase === 'rebuilding' || phase.phase === 'reconnecting') &&
		phase.generation === command.generation &&
		phase.activeCommandId === command.commandId
	);
};

// Decides whether a command buffered while no runner was alive may still be
// flushed to the next runner. Only finalization commands survive, and only
// while the machine still stands behind the exact session incarnation that
// emitted them: the phase must match AND the phase's generation must equal the
// command's. Phase alone is not enough — a LeaveVoiceSession buffered before a
// RecoveryCleared (logout/teardown) must not fire an unscoped voice.leave
// against a later session, and even a rejoin of the same channel is a new
// generation. Recovery-step commands are never flushed: Resumed re-issues the
// active step for rebuilding/reconnecting phases, and a flushed duplicate
// would race the re-issued runner's side effects (double transport rebuild,
// double restore RPC).
const shouldFlushBufferedVoiceSessionCommand = (state: TVoiceSessionState, command: TVoiceSessionCommand): boolean => {
	const { phase } = state;

	switch (command.type) {
		case 'RecoverDesktopAppAudio':
			return phase.phase === 'connected' && phase.generation !== undefined && phase.generation === command.generation;
		case 'LeaveVoiceSession':
		case 'ClearFailedSession':
			return phase.phase === 'failed' && phase.generation !== undefined && phase.generation === command.generation;
		default:
			return false;
	}
};

const scheduleReconnectStep = (state: TVoiceSessionState): TVoiceSessionReducerResult => {
	const { phase } = state;

	if (phase.phase !== 'reconnecting') {
		return emptyResult(state);
	}

	if (phase.snapshot === undefined) {
		return withCommand(state, {
			type: 'CaptureRecoverySnapshot',
			recovery: 'reconnecting',
			generation: phase.generation,
		});
	}

	if (phase.step === 'waitingOnline') {
		return withCommand(state, {
			type: 'WaitOnline',
			generation: phase.generation,
			expiresAt: phase.pending.expiresAt,
		});
	}

	if (phase.step === 'waitingAuth') {
		return withCommand(state, {
			type: 'WaitAuth',
			generation: phase.generation,
			expiresAt: phase.pending.expiresAt,
		});
	}

	if (phase.step === 'restoring') {
		return withCommand(state, {
			type: 'RestoreVoiceSession',
			generation: phase.generation,
			pending: phase.pending,
			attempt: phase.retryAttempt,
			snapshot: phase.snapshot,
		});
	}

	if (phase.step === 'restoreWatch') {
		return withCommand(state, {
			type: 'RestoreWatchIntent',
			generation: phase.generation,
			snapshot: phase.snapshot,
		});
	}

	if (phase.step === 'retryDelay') {
		// retryAttempt was already incremented when the step was entered; the
		// delay command is keyed to the attempt that just failed.
		return withCommand(state, {
			type: 'RetryDelay',
			generation: phase.generation,
			attempt: Math.max(0, phase.retryAttempt - 1),
			expiresAt: phase.pending.expiresAt,
		});
	}

	return emptyResult(state);
};

const startReconnecting = (
	state: TVoiceSessionState,
	event: Extract<TVoiceSessionTriggerEvent, { type: 'WsDropped' }>,
): TVoiceSessionReducerResult => {
	const [baseState, generation] = nextGeneration(state);
	const nextState: TVoiceSessionState = {
		...baseState,
		pendingVoiceReconnect: event.pending,
		reconnectingSince: event.now,
		reconnectAuthenticated: event.authenticated,
		phase: {
			phase: 'reconnecting',
			step: !event.online ? 'waitingOnline' : event.authenticated ? 'restoring' : 'waitingAuth',
			reconnectingSince: event.now,
			authenticated: event.authenticated,
			pending: event.pending,
			retryAttempt: 0,
			consecutiveUnknownErrors: 0,
			generation,
		},
	};

	return scheduleReconnectStep(nextState);
};

const startCapturedReconnect = (
	state: TVoiceSessionState,
	event: Extract<TVoiceSessionTriggerEvent, { type: 'ReconnectStarted' }>,
): TVoiceSessionReducerResult => {
	const pending = state.phase.phase === 'reconnecting' ? state.phase.pending : state.pendingVoiceReconnect;

	if (!pending) {
		// Records the start on the facade mirror without entering 'reconnecting'.
		// A later ReconnectIntentCaptured will NOT start recovery, and
		// ensureVoiceReconnectStarted early-returns once reconnectingSince is set —
		// so callers must capture intent BEFORE starting the reconnect (as
		// lib/trpc.ts and features/server/actions.ts do) or recovery never runs.
		return emptyResult({ ...state, reconnectingSince: event.now, reconnectAuthenticated: event.authenticated });
	}

	if (state.phase.phase === 'reconnecting') {
		return emptyResult(state);
	}

	return startReconnecting(state, {
		type: 'WsDropped',
		pending,
		now: event.now,
		online: event.online,
		authenticated: event.authenticated,
	});
};

const startRebuilding = (
	state: TVoiceSessionState,
	event: Extract<TVoiceSessionTriggerEvent, { type: 'TransportFailed' }>,
): TVoiceSessionReducerResult => {
	const [baseState, generation] = nextGeneration(state);
	const nextState: TVoiceSessionState = {
		...baseState,
		phase: {
			phase: 'rebuilding',
			channelId: event.channelId,
			nonce: event.nonce,
			attempt: 0,
			nonceRestarts: 0,
			consecutiveUnknownErrors: 0,
			generation,
		},
	};

	return withCommand(nextState, {
		type: 'CaptureRecoverySnapshot',
		recovery: 'rebuilding',
		generation,
	});
};

// Commands are delivered only to subscribers that are alive at dispatch time,
// so a command runner (the VoiceProvider) that remounts mid-recovery would
// otherwise leave the machine stranded waiting on a command nobody executes.
// Resuming re-issues the current step under a fresh generation, which also
// invalidates any still-running command from the previous runner instance.
const reduceResumed = (state: TVoiceSessionState): TVoiceSessionReducerResult => {
	const { phase } = state;

	if (phase.phase === 'rebuilding') {
		const [baseState, generation] = nextGeneration(state);
		const nextState: TVoiceSessionState = { ...baseState, phase: { ...phase, generation } };

		if (phase.snapshot === undefined) {
			return withCommand(nextState, { type: 'CaptureRecoverySnapshot', recovery: 'rebuilding', generation });
		}

		return withCommand(nextState, {
			type: 'RebuildTransports',
			generation,
			channelId: phase.channelId,
			nonce: phase.nonce,
			attempt: phase.attempt,
			snapshot: phase.snapshot,
		});
	}

	if (phase.phase === 'reconnecting') {
		const [baseState, generation] = nextGeneration(state);
		const resumedPhase: Extract<TVoiceSessionPhase, { phase: 'reconnecting' }> = {
			...phase,
			// RestoreSucceeded means the old provider initialized its own local
			// transports. A provider unmount tears those transports down, so resuming
			// from restoreWatch would only rehydrate intent and falsely mark the new
			// provider connected with no transports. Re-run restore/init first; the
			// retained snapshot then drives restoreWatch again on success.
			step: phase.step === 'restoreWatch' ? 'restoring' : phase.step,
			generation,
		};

		return scheduleReconnectStep({ ...baseState, phase: resumedPhase });
	}

	return emptyResult(state);
};

const reduceRecoveryStarted = (
	state: TVoiceSessionState,
	event: Extract<TVoiceSessionResultEvent, { type: 'RecoveryStarted' }>,
): TVoiceSessionReducerResult => {
	const { phase } = state;

	if (!isCurrentVoiceSessionCommand(state, event)) {
		return emptyResult(state);
	}

	if (phase.phase === 'rebuilding') {
		const nextState: TVoiceSessionState = {
			...state,
			phase: { ...phase, snapshot: event.snapshot },
		};

		return withCommand(nextState, {
			type: 'RebuildTransports',
			generation: phase.generation,
			channelId: phase.channelId,
			nonce: phase.nonce,
			attempt: phase.attempt,
			snapshot: event.snapshot,
		});
	}

	if (phase.phase === 'reconnecting') {
		return scheduleReconnectStep({
			...state,
			phase: { ...phase, snapshot: event.snapshot },
		});
	}

	return emptyResult(state);
};

const reduceRebuildFailed = (
	state: TVoiceSessionState,
	event: Extract<TVoiceSessionResultEvent, { type: 'RebuildFailed' }>,
): TVoiceSessionReducerResult => {
	const { phase } = state;

	if (phase.phase !== 'rebuilding' || !isCurrentVoiceSessionCommand(state, event)) {
		return emptyResult(state);
	}

	const classification = classifyVoiceReconnectError(event.error, {
		consecutiveUnknownErrors: phase.consecutiveUnknownErrors,
	});

	if (classification.kind === 'terminal') {
		return failSession(state, classification.clearReason, phase.channelId, 'leave');
	}

	if (phase.attempt + 1 >= VOICE_SESSION_REBUILD_MAX_ATTEMPTS) {
		return failSession(state, 'restore-terminal-error', phase.channelId, 'leave');
	}

	if (phase.snapshot === undefined) {
		return emptyResult(state);
	}

	const nextPhase: TVoiceSessionPhase = {
		...phase,
		attempt: phase.attempt + 1,
		consecutiveUnknownErrors: classification.countsAsUnknown ? phase.consecutiveUnknownErrors + 1 : 0,
	};

	return withCommand(
		{
			...state,
			phase: nextPhase,
		},
		{
			type: 'RebuildTransports',
			generation: phase.generation,
			channelId: phase.channelId,
			nonce: phase.nonce,
			attempt: phase.attempt + 1,
			snapshot: phase.snapshot,
		},
	);
};

const reduceNonceChanged = (
	state: TVoiceSessionState,
	event: Extract<TVoiceSessionTriggerEvent, { type: 'NonceChanged' }>,
): TVoiceSessionReducerResult => {
	const { phase } = state;

	if (phase.phase !== 'rebuilding' || !isCurrentVoiceSessionCommand(state, event) || phase.nonce === event.nonce) {
		return emptyResult(state);
	}

	if (phase.nonceRestarts + 1 > VOICE_SESSION_REBUILD_MAX_NONCE_RESTARTS) {
		// The rebuild is abandoned with transports already torn down, so this must
		// emit the same leave/teardown as an exhausted-attempts failure — without
		// it the server keeps a ghost participant and the user gets no signal.
		return failSession(state, 'restore-terminal-error', phase.channelId, 'leave');
	}

	if (phase.snapshot === undefined) {
		return emptyResult({
			...state,
			phase: {
				...phase,
				nonce: event.nonce,
				attempt: 0,
				nonceRestarts: phase.nonceRestarts + 1,
				consecutiveUnknownErrors: 0,
			},
		});
	}

	const nextPhase: TVoiceSessionPhase = {
		...phase,
		nonce: event.nonce,
		attempt: 0,
		nonceRestarts: phase.nonceRestarts + 1,
		consecutiveUnknownErrors: 0,
	};

	return withCommand(
		{ ...state, phase: nextPhase },
		{
			type: 'RebuildTransports',
			generation: phase.generation,
			channelId: phase.channelId,
			nonce: event.nonce,
			attempt: 0,
			snapshot: phase.snapshot,
		},
	);
};

const reduceRestoreFailed = (
	state: TVoiceSessionState,
	event: Extract<TVoiceSessionResultEvent, { type: 'RestoreFailed' }>,
): TVoiceSessionReducerResult => {
	const { phase } = state;

	if (phase.phase !== 'reconnecting' || phase.step !== 'restoring' || !isCurrentVoiceSessionCommand(state, event)) {
		return emptyResult(state);
	}

	const classification = classifyVoiceReconnectError(event.error, {
		consecutiveUnknownErrors: phase.consecutiveUnknownErrors,
	});
	const serverSessionEstablished = phase.serverSessionEstablished === true || event.serverSessionEstablished === true;

	if (classification.kind === 'terminal') {
		// Always attempt the leave, even when no restore succeeded this cycle:
		// joinServer adopts the pre-drop seat onto the reconnected socket, so the
		// server can still hold a seat bound to this connection. The server-side
		// incarnation guard makes the leave a no-op when the seat isn't ours.
		return failSession(
			{
				...state,
				phase: { ...phase, serverSessionEstablished },
			},
			classification.clearReason,
			phase.pending.channelId,
			'leave-and-clear',
		);
	}

	const consecutiveUnknownErrors = classification.countsAsUnknown ? phase.consecutiveUnknownErrors + 1 : 0;

	return scheduleReconnectStep({
		...state,
		phase: {
			...phase,
			step: 'retryDelay',
			retryAttempt: phase.retryAttempt + 1,
			consecutiveUnknownErrors,
			serverSessionEstablished,
		},
	});
};

const reduceVoiceSession = (state: TVoiceSessionState, event: TVoiceSessionEvent): TVoiceSessionReducerResult => {
	switch (event.type) {
		// Once recovery owns the session, join lifecycle events are stale echoes
		// of an init that started before the drop. Letting them through would
		// overwrite the reconnecting phase — JoinSucceeded/JoinFailed even clear
		// the pending recovery — stranding the user instead of restoring. The
		// restore path rebuilds transports from scratch, so dropping them is safe.
		case 'JoinRequested':
			if (state.phase.phase === 'reconnecting') {
				return emptyResult(state);
			}

			return emptyResult({ ...state, phase: { phase: 'joining', channelId: event.channelId } });
		case 'JoinSucceeded':
			if (state.phase.phase === 'reconnecting') {
				return emptyResult(state);
			}

			{
				const [baseState, generation] = nextGeneration(state);

				return emptyResult({
					...clearReconnectFacadeRecovery(baseState),
					phase: { phase: 'connected', channelId: event.channelId, generation },
				});
			}
		case 'JoinFailed':
			if (state.phase.phase === 'reconnecting') {
				return emptyResult(state);
			}

			return emptyResult({
				...clearReconnectFacadeRecovery(state),
				phase: { phase: 'failed', reason: event.reason, channelId: event.channelId },
			});
		case 'WsDropped':
			if (state.phase.phase === 'reconnecting') {
				const nextPhase: Extract<TVoiceSessionPhase, { phase: 'reconnecting' }> = {
					...state.phase,
					pending: event.pending,
					authenticated: event.authenticated,
				};
				const nextState: TVoiceSessionState = {
					...state,
					pendingVoiceReconnect: event.pending,
					reconnectAuthenticated: event.authenticated,
					phase: nextPhase,
				};

				if (
					(state.phase.step === 'restoring' || state.phase.step === 'restoreWatch') &&
					(!event.online || !event.authenticated)
				) {
					return scheduleReconnectStep({
						...nextState,
						phase: {
							...nextPhase,
							step: event.online ? 'waitingAuth' : 'waitingOnline',
						},
					});
				}

				return emptyResult(nextState);
			}

			return startReconnecting(state, event);
		case 'ReconnectIntentCaptured':
			if (state.phase.phase === 'reconnecting') {
				const nextPhase: Extract<TVoiceSessionPhase, { phase: 'reconnecting' }> = {
					...state.phase,
					pending: event.pending,
				};
				const nextState: TVoiceSessionState = {
					...state,
					pendingVoiceReconnect: event.pending,
					phase: nextPhase,
				};

				if (
					state.phase.step !== 'restoring' ||
					(state.phase.pending.micMuted === event.pending.micMuted &&
						state.phase.pending.soundMuted === event.pending.soundMuted)
				) {
					return emptyResult(nextState);
				}

				// The restore command owns a snapshot by value. Replace an active
				// command when local mute intent changes so an older restore response
				// cannot publish the pre-transition state after terminal capture loss.
				const [nextStateWithGeneration, generation] = nextGeneration(nextState);
				return scheduleReconnectStep({
					...nextStateWithGeneration,
					phase: {
						...nextPhase,
						generation,
						activeCommandId: undefined,
					},
				});
			}

			return emptyResult({ ...state, pendingVoiceReconnect: event.pending });
		case 'ReconnectStarted':
			return startCapturedReconnect(state, event);
		case 'ReconnectStartCleared':
			if (state.phase.phase === 'reconnecting') {
				return emptyResult({
					...state,
					phase: { phase: 'idle' },
					pendingVoiceReconnect: state.phase.pending,
					reconnectingSince: undefined,
					reconnectAuthenticated: state.phase.authenticated,
				});
			}

			return emptyResult({ ...state, reconnectingSince: undefined });
		case 'TransportFailed':
			if (
				event.connectedGeneration !== undefined &&
				(state.phase.phase !== 'connected' ||
					state.phase.channelId !== event.channelId ||
					state.phase.generation !== event.connectedGeneration)
			) {
				return emptyResult(state);
			}

			if (state.phase.phase === 'reconnecting') {
				return emptyResult(state);
			}

			{
				const result = startRebuilding(state, event);
				const recoveryGeneration =
					result.state.phase.phase === 'rebuilding' ? result.state.phase.generation : undefined;

				if (recoveryGeneration === undefined) {
					return result;
				}

				return {
					...result,
					transportRecoveryTransition: {
						type: 'failure-accepted',
						channelId: event.channelId,
						connectedGeneration: event.connectedGeneration,
						recoveryGeneration,
					},
				};
			}
		case 'TransportRecoveryExhausted':
			if (
				event.connectedGeneration !== undefined &&
				(state.phase.phase !== 'connected' ||
					state.phase.channelId !== event.channelId ||
					state.phase.generation !== event.connectedGeneration)
			) {
				return emptyResult(state);
			}

			if (state.phase.phase === 'reconnecting') {
				return emptyResult(state);
			}

			{
				const result = failSession(state, 'restore-terminal-error', event.channelId, 'leave');

				return {
					...result,
					transportRecoveryTransition: {
						type: 'exhaustion-accepted',
						channelId: event.channelId,
						connectedGeneration: event.connectedGeneration,
					},
				};
			}
		case 'SocketAuthenticated':
			if (state.phase.phase !== 'reconnecting') {
				return emptyResult({ ...state, reconnectAuthenticated: true });
			}

			return emptyResult({
				...state,
				reconnectAuthenticated: true,
				phase: {
					...state.phase,
					authenticated: true,
				},
			});
		case 'SocketUnauthenticated':
			if (state.phase.phase !== 'reconnecting') {
				return emptyResult({ ...state, reconnectAuthenticated: false });
			}

			if (state.phase.step === 'restoring' || state.phase.step === 'restoreWatch') {
				return scheduleReconnectStep({
					...state,
					reconnectAuthenticated: false,
					phase: { ...state.phase, authenticated: false, step: 'waitingAuth' },
				});
			}

			return emptyResult({
				...state,
				reconnectAuthenticated: false,
				phase: { ...state.phase, authenticated: false },
			});
		case 'NonceChanged':
			return reduceNonceChanged(state, event);
		case 'Terminated':
			return failSession(state, event.reason, event.channelId);
		case 'RecoveryCleared':
			return emptyResult({
				...state,
				phase: { phase: 'idle' },
				pendingVoiceReconnect: undefined,
				reconnectingSince: undefined,
				suppression: undefined,
				reconnectAuthenticated: false,
			});
		case 'ReconnectSuppressionChanged':
			return emptyResult({ ...state, suppression: event.suppression });
		case 'RecoveryStarted':
			return reduceRecoveryStarted(state, event);
		case 'Resumed':
			return reduceResumed(state);
		case 'RebuildSucceeded':
			if (state.phase.phase !== 'rebuilding' || !isCurrentVoiceSessionCommand(state, event)) {
				return emptyResult(state);
			}

			{
				const channelId = state.phase.channelId;
				const generation = state.phase.generation;
				const result = withCommand(
					{
						...clearReconnectFacadeRecovery(state),
						phase: { phase: 'connected', channelId, generation },
					},
					{ type: 'RecoverDesktopAppAudio', generation },
				);

				return {
					...result,
					transportRecoveryTransition: { type: 'rebuild-succeeded', channelId, generation, now: event.now },
				};
			}
		case 'RebuildFailed':
			return reduceRebuildFailed(state, event);
		case 'RestoreSucceeded':
			if (
				state.phase.phase !== 'reconnecting' ||
				state.phase.step !== 'restoring' ||
				!state.phase.authenticated ||
				!isCurrentVoiceSessionCommand(state, event)
			) {
				return emptyResult(state);
			}

			return scheduleReconnectStep({
				...state,
				phase: {
					...state.phase,
					step: 'restoreWatch',
					serverSessionEstablished: event.serverSessionEstablished,
				},
			});
		case 'RestoreFailed':
			return reduceRestoreFailed(state, event);
		case 'OnlineReady':
			if (
				state.phase.phase !== 'reconnecting' ||
				state.phase.step !== 'waitingOnline' ||
				!isCurrentVoiceSessionCommand(state, event)
			) {
				return emptyResult(state);
			}

			return scheduleReconnectStep({
				...state,
				phase: { ...state.phase, step: state.phase.authenticated ? 'restoring' : 'waitingAuth' },
			});
		case 'OnlineExpired':
		case 'AuthExpired':
		case 'RetryDelayExpired': {
			if (!isCurrentVoiceSessionCommand(state, event)) {
				return emptyResult(state);
			}

			const reconnectPhase = state.phase.phase === 'reconnecting' ? state.phase : undefined;

			// 'leave-and-clear' even without an established restore: a residual seat
			// may still be bound to this connection (see reduceRestoreFailed). The
			// runner skips the leave while the socket is down, and the server's
			// disconnect grace reaps the seat in that case instead.
			return failSession(state, 'reconnect-expired', reconnectPhase?.pending.channelId, 'leave-and-clear');
		}
		case 'AuthReady':
			if (
				state.phase.phase !== 'reconnecting' ||
				state.phase.step !== 'waitingAuth' ||
				!isCurrentVoiceSessionCommand(state, event)
			) {
				return emptyResult(state);
			}

			return scheduleReconnectStep({
				...state,
				reconnectAuthenticated: true,
				phase: { ...state.phase, authenticated: true, step: 'restoring' },
			});
		case 'AuthCleared':
			if (
				state.phase.phase !== 'reconnecting' ||
				state.phase.step !== 'waitingAuth' ||
				!isCurrentVoiceSessionCommand(state, event)
			) {
				return emptyResult(state);
			}

			return emptyResult({ ...clearReconnectFacadeRecovery(state), phase: { phase: 'idle' } });
		case 'RetryDelayElapsed':
			if (
				state.phase.phase !== 'reconnecting' ||
				state.phase.step !== 'retryDelay' ||
				!isCurrentVoiceSessionCommand(state, event)
			) {
				return emptyResult(state);
			}

			return scheduleReconnectStep({
				...state,
				phase: { ...state.phase, step: state.phase.authenticated ? 'restoring' : 'waitingAuth' },
			});
		case 'WatchIntentRehydrated':
			if (
				state.phase.phase !== 'reconnecting' ||
				state.phase.step !== 'restoreWatch' ||
				!isCurrentVoiceSessionCommand(state, event)
			) {
				return emptyResult(state);
			}

			{
				const channelId = state.phase.pending.channelId;
				const generation = state.phase.generation;

				return {
					...emptyResult({
						...clearReconnectFacadeRecovery(state),
						phase: { phase: 'connected', channelId, generation },
						suppression: {
							channelId,
							peerUserIds: [...state.phase.pending.peerUserIds],
							expiresAt: event.now + VOICE_RECONNECT_SUPPRESSION_MS,
						},
					}),
					transportRecoveryTransition: { type: 'reconnect-succeeded', channelId, generation, now: event.now },
				};
			}
	}
};

// Direct machine selectors. While reconnecting, the phase owns the live
// values; the top-level fields are the facade mirror kept for the other
// phases. Executor waits and React rendering read state through these so
// Zustand projection synchronization order can never affect correctness.
// Selectors return references out of the immutable state, so
// useSyncExternalStore-style Object.is comparisons stay stable between
// dispatches.
const selectPendingVoiceReconnect = (state: TVoiceSessionState): TPendingVoiceReconnect | undefined =>
	state.phase.phase === 'reconnecting' ? state.phase.pending : state.pendingVoiceReconnect;

const selectReconnectingSince = (state: TVoiceSessionState): number | undefined =>
	state.phase.phase === 'reconnecting' ? state.phase.reconnectingSince : state.reconnectingSince;

const selectReconnectAuthenticated = (state: TVoiceSessionState): boolean =>
	state.phase.phase === 'reconnecting' ? state.phase.authenticated : state.reconnectAuthenticated;

const selectVoiceReconnectSuppression = (state: TVoiceSessionState): TVoiceReconnectSuppression | undefined =>
	state.suppression;

const selectVoiceSessionConnectionStatus = (state: TVoiceSessionState): TVoiceSessionConnectionStatus => {
	switch (state.phase.phase) {
		case 'idle':
			return 'disconnected';
		case 'joining':
		case 'rebuilding':
		case 'reconnecting':
			return 'connecting';
		case 'connected':
			return 'connected';
		case 'failed':
			return 'failed';
	}
};

export type {
	TTransportRecoveryTransition,
	TVoiceSessionCommand,
	TVoiceSessionConnectionStatus,
	TVoiceSessionEvent,
	TVoiceSessionPhase,
	TVoiceSessionReducerResult,
	TVoiceSessionState,
	TWatchedExternalStreamsSnapshot,
	TWatchedRemoteStreamsSnapshot,
};
export {
	createInitialVoiceSessionState,
	isCurrentVoiceSessionCommand,
	reduceVoiceSession,
	selectPendingVoiceReconnect,
	selectReconnectAuthenticated,
	selectReconnectingSince,
	selectVoiceReconnectSuppression,
	selectVoiceSessionConnectionStatus,
	shouldFlushBufferedVoiceSessionCommand,
	VOICE_RECONNECT_SUPPRESSION_MS,
	VOICE_SESSION_REBUILD_MAX_ATTEMPTS,
	VOICE_SESSION_REBUILD_MAX_NONCE_RESTARTS,
	voiceSessionResultState,
};
