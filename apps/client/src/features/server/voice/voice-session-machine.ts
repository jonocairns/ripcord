import type { StreamKind } from '@sharkord/shared';
import type { TClearReason, TPendingVoiceReconnect, TVoiceReconnectSuppression } from './reconnect-coordinator';
import { classifyVoiceReconnectError } from './reconnect-policy';

const VOICE_SESSION_REBUILD_MAX_ATTEMPTS = 3;
const VOICE_SESSION_REBUILD_MAX_NONCE_RESTARTS = 5;

type TWatchedExternalStreamsSnapshot = {
	audio: boolean;
	video: boolean;
};

type TWatchedRemoteStreamsSnapshot = {
	remoteUserStreams: Record<number, StreamKind[]>;
	externalStreams: Record<number, TWatchedExternalStreamsSnapshot>;
};

type TVoiceSessionPhase =
	| { phase: 'idle' }
	| { phase: 'joining'; channelId: number }
	| { phase: 'connected'; channelId: number }
	| {
			phase: 'rebuilding';
			channelId: number;
			nonce: number;
			attempt: number;
			nonceRestarts: number;
			consecutiveUnknownErrors: number;
			generation: number;
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
			snapshot?: TWatchedRemoteStreamsSnapshot;
			serverSessionEstablished?: boolean;
	  }
	| { phase: 'failed'; reason: TClearReason; channelId?: number };

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
	| { type: 'LeaveVoiceSession'; commandId: number; generation: number }
	| { type: 'ClearFailedSession'; commandId: number; generation: number; reason: TClearReason; channelId?: number };

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
	| { type: 'TransportFailed'; channelId: number; nonce: number }
	| { type: 'SocketAuthenticated' }
	| { type: 'SocketUnauthenticated' }
	| { type: 'NonceChanged'; nonce: number }
	| { type: 'Terminated'; reason: TClearReason; channelId?: number }
	| { type: 'ReconnectIntentCaptured'; pending: TPendingVoiceReconnect }
	| { type: 'ReconnectStarted'; now: number; online: boolean; authenticated: boolean }
	| { type: 'ReconnectStartCleared' }
	| { type: 'RecoveryCleared'; reason: TClearReason }
	| { type: 'ReconnectSuppressionChanged'; suppression: TVoiceReconnectSuppression | undefined }
	| { type: 'RecoveryStarted'; generation: number; snapshot: TWatchedRemoteStreamsSnapshot };

type TVoiceSessionResultEvent =
	| { type: 'RebuildSucceeded'; generation: number }
	| { type: 'RebuildFailed'; generation: number; error: unknown }
	| { type: 'RestoreSucceeded'; generation: number; serverSessionEstablished?: boolean }
	| { type: 'RestoreFailed'; generation: number; error: unknown; serverSessionEstablished?: boolean }
	| { type: 'OnlineReady'; generation: number }
	| { type: 'OnlineExpired'; generation: number }
	| { type: 'AuthReady'; generation: number }
	| { type: 'AuthExpired'; generation: number }
	| { type: 'AuthCleared'; generation: number }
	| { type: 'RetryDelayElapsed'; generation: number }
	| { type: 'RetryDelayExpired'; generation: number }
	| { type: 'WatchIntentRehydrated'; generation: number };

type TVoiceSessionEvent = TVoiceSessionTriggerEvent | TVoiceSessionResultEvent;

type TVoiceSessionReducerResult = {
	state: TVoiceSessionState;
	commands: TVoiceSessionCommand[];
};

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

const withCommand = (state: TVoiceSessionState, command: TVoiceSessionCommandInput): TVoiceSessionReducerResult => ({
	state: {
		...state,
		nextCommandId: state.nextCommandId + 1,
	},
	commands: [addCommandId(command, state.nextCommandId)],
});

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

const failSession = (
	state: TVoiceSessionState,
	reason: TClearReason,
	channelId?: number,
	command?: 'clear' | 'leave-and-clear',
): TVoiceSessionReducerResult => {
	const [baseState, generation] = nextGeneration(state);
	const failedState: TVoiceSessionState = {
		...clearReconnectFacadeRecovery(baseState),
		phase: { phase: 'failed', reason, channelId },
	};

	if (command === 'leave-and-clear') {
		return withCommand(failedState, { type: 'LeaveVoiceSession', generation });
	}

	if (command === 'clear') {
		return withCommand(failedState, { type: 'ClearFailedSession', generation, reason, channelId });
	}

	return emptyResult(failedState);
};

const isCurrentGeneration = (state: TVoiceSessionState, generation: number): boolean => {
	const { phase } = state;

	return (phase.phase === 'rebuilding' || phase.phase === 'reconnecting') && phase.generation === generation;
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

const reduceRecoveryStarted = (
	state: TVoiceSessionState,
	event: Extract<TVoiceSessionTriggerEvent, { type: 'RecoveryStarted' }>,
): TVoiceSessionReducerResult => {
	const { phase } = state;

	if (!isCurrentGeneration(state, event.generation)) {
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

	if (phase.phase !== 'rebuilding' || phase.generation !== event.generation) {
		return emptyResult(state);
	}

	const classification = classifyVoiceReconnectError(event.error, {
		consecutiveUnknownErrors: phase.consecutiveUnknownErrors,
	});

	if (classification.kind === 'terminal') {
		return failSession(state, classification.clearReason, phase.channelId, 'leave-and-clear');
	}

	if (phase.attempt + 1 >= VOICE_SESSION_REBUILD_MAX_ATTEMPTS) {
		return failSession(state, 'restore-terminal-error', phase.channelId, 'leave-and-clear');
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

	if (phase.phase !== 'rebuilding' || phase.nonce === event.nonce) {
		return emptyResult(state);
	}

	if (phase.nonceRestarts + 1 > VOICE_SESSION_REBUILD_MAX_NONCE_RESTARTS) {
		return failSession(state, 'restore-terminal-error', phase.channelId);
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

	if (phase.phase !== 'reconnecting' || phase.generation !== event.generation) {
		return emptyResult(state);
	}

	const classification = classifyVoiceReconnectError(event.error, {
		consecutiveUnknownErrors: phase.consecutiveUnknownErrors,
	});

	if (classification.kind === 'terminal') {
		return failSession(
			{
				...state,
				phase: { ...phase, serverSessionEstablished: event.serverSessionEstablished },
			},
			classification.clearReason,
			phase.pending.channelId,
			event.serverSessionEstablished === true ? 'leave-and-clear' : 'clear',
		);
	}

	const consecutiveUnknownErrors = classification.countsAsUnknown ? phase.consecutiveUnknownErrors + 1 : 0;
	const nextState: TVoiceSessionState = {
		...state,
		phase: {
			...phase,
			step: 'retryDelay',
			retryAttempt: phase.retryAttempt + 1,
			consecutiveUnknownErrors,
			serverSessionEstablished: event.serverSessionEstablished,
		},
	};

	return withCommand(nextState, {
		type: 'RetryDelay',
		generation: phase.generation,
		attempt: phase.retryAttempt,
		expiresAt: phase.pending.expiresAt,
	});
};

const reduceVoiceSession = (state: TVoiceSessionState, event: TVoiceSessionEvent): TVoiceSessionReducerResult => {
	switch (event.type) {
		case 'JoinRequested':
			return emptyResult({ ...state, phase: { phase: 'joining', channelId: event.channelId } });
		case 'JoinSucceeded':
			return emptyResult({
				...clearReconnectFacadeRecovery(state),
				phase: { phase: 'connected', channelId: event.channelId },
			});
		case 'JoinFailed':
			return emptyResult({
				...clearReconnectFacadeRecovery(state),
				phase: { phase: 'failed', reason: event.reason, channelId: event.channelId },
			});
		case 'WsDropped':
			if (state.phase.phase === 'reconnecting') {
				return emptyResult({
					...state,
					pendingVoiceReconnect: event.pending,
					phase: {
						...state.phase,
						pending: event.pending,
					},
				});
			}

			return startReconnecting(state, event);
		case 'ReconnectIntentCaptured':
			if (state.phase.phase === 'reconnecting') {
				return emptyResult({
					...state,
					pendingVoiceReconnect: event.pending,
					phase: { ...state.phase, pending: event.pending },
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
			if (state.phase.phase === 'reconnecting') {
				return emptyResult(state);
			}

			return startRebuilding(state, event);
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

			return emptyResult({
				...state,
				reconnectAuthenticated: false,
				phase: { ...state.phase, authenticated: false, step: 'waitingAuth' },
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
		case 'RebuildSucceeded':
			if (state.phase.phase !== 'rebuilding' || state.phase.generation !== event.generation) {
				return emptyResult(state);
			}

			return withCommand(
				{
					...clearReconnectFacadeRecovery(state),
					phase: { phase: 'connected', channelId: state.phase.channelId },
				},
				{ type: 'RecoverDesktopAppAudio', generation: state.phase.generation },
			);
		case 'RebuildFailed':
			return reduceRebuildFailed(state, event);
		case 'RestoreSucceeded':
			if (state.phase.phase !== 'reconnecting' || state.phase.generation !== event.generation) {
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
			if (state.phase.phase !== 'reconnecting' || state.phase.generation !== event.generation) {
				return emptyResult(state);
			}

			return scheduleReconnectStep({
				...state,
				phase: { ...state.phase, step: state.phase.authenticated ? 'restoring' : 'waitingAuth' },
			});
		case 'OnlineExpired':
		case 'AuthExpired':
		case 'RetryDelayExpired':
			if (!isCurrentGeneration(state, event.generation)) {
				return emptyResult(state);
			}

			return failSession(
				state,
				'reconnect-expired',
				state.phase.phase === 'reconnecting' ? state.phase.pending.channelId : undefined,
				'clear',
			);
		case 'AuthReady':
			if (state.phase.phase !== 'reconnecting' || state.phase.generation !== event.generation) {
				return emptyResult(state);
			}

			return scheduleReconnectStep({
				...state,
				reconnectAuthenticated: true,
				phase: { ...state.phase, authenticated: true, step: 'restoring' },
			});
		case 'AuthCleared':
			if (state.phase.phase !== 'reconnecting' || state.phase.generation !== event.generation) {
				return emptyResult(state);
			}

			return emptyResult({ ...clearReconnectFacadeRecovery(state), phase: { phase: 'idle' } });
		case 'RetryDelayElapsed':
			if (state.phase.phase !== 'reconnecting' || state.phase.generation !== event.generation) {
				return emptyResult(state);
			}

			return scheduleReconnectStep({
				...state,
				phase: { ...state.phase, step: state.phase.authenticated ? 'restoring' : 'waitingAuth' },
			});
		case 'WatchIntentRehydrated':
			if (state.phase.phase !== 'reconnecting' || state.phase.generation !== event.generation) {
				return emptyResult(state);
			}

			return emptyResult({
				...clearReconnectFacadeRecovery(state),
				phase: { phase: 'connected', channelId: state.phase.pending.channelId },
				suppression: {
					channelId: state.phase.pending.channelId,
					peerUserIds: [...state.phase.pending.peerUserIds],
					expiresAt: state.phase.pending.expiresAt,
				},
			});
	}
};

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
	reduceVoiceSession,
	selectVoiceSessionConnectionStatus,
	VOICE_SESSION_REBUILD_MAX_ATTEMPTS,
	VOICE_SESSION_REBUILD_MAX_NONCE_RESTARTS,
	voiceSessionResultState,
};
