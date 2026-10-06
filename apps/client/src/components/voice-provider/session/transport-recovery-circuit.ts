import { VOICE_TRANSPORT_RECOVERY_PROBATION_MS } from '@sharkord/shared';
import type { TTransportRecoveryTransition } from '@/features/server/voice/voice-session-machine';

const TRANSPORT_RECOVERY_MAX_RAPID_FAILURES = 3;
const TRANSPORT_RECOVERY_STABILITY_MS = VOICE_TRANSPORT_RECOVERY_PROBATION_MS;

type TTransportRecoveryCircuitState = {
	channelId: number;
	generation: number;
	stabilityStartedAt?: number;
	rapidFailureCount: number;
};

type TTransportRecoveryCircuitDecision = {
	state: TTransportRecoveryCircuitState;
	action: 'recover' | 'stop';
};

type TTransportFailureDispatchOutcome = {
	accepted: boolean;
	circuitState: TTransportRecoveryCircuitState | undefined;
};

const resolveTransportFailureDispatchOutcome = ({
	circuitDecision,
	transition,
	previousCircuitState,
}: {
	circuitDecision: TTransportRecoveryCircuitDecision;
	transition: TTransportRecoveryTransition | undefined;
	previousCircuitState: TTransportRecoveryCircuitState | undefined;
}): TTransportFailureDispatchOutcome => {
	const isFailureTransition = transition?.type === 'failure-accepted' || transition?.type === 'exhaustion-accepted';
	const matchesProposedSession =
		isFailureTransition &&
		transition.channelId === circuitDecision.state.channelId &&
		transition.connectedGeneration === circuitDecision.state.generation;

	if (circuitDecision.action === 'recover' && transition?.type === 'failure-accepted' && matchesProposedSession) {
		return {
			accepted: true,
			circuitState: {
				...circuitDecision.state,
				generation: transition.recoveryGeneration,
			},
		};
	}

	if (circuitDecision.action === 'stop' && transition?.type === 'exhaustion-accepted' && matchesProposedSession) {
		return { accepted: true, circuitState: circuitDecision.state };
	}

	return { accepted: false, circuitState: previousCircuitState };
};

const resolveTransportRecoveryCircuitDecision = (input: {
	state: TTransportRecoveryCircuitState | undefined;
	channelId: number;
	generation: number;
	now: number;
	maxRapidFailures?: number;
	stabilityMs?: number;
}): TTransportRecoveryCircuitDecision => {
	const stabilityMs = input.stabilityMs ?? TRANSPORT_RECOVERY_STABILITY_MS;
	const previousState = input.state;
	const matchesConnectedGeneration =
		previousState !== undefined &&
		previousState.channelId === input.channelId &&
		previousState.generation === input.generation;
	const continuesRapidFailureSequence =
		matchesConnectedGeneration &&
		(previousState.stabilityStartedAt === undefined || input.now - previousState.stabilityStartedAt < stabilityMs);
	const rapidFailureCount = continuesRapidFailureSequence ? previousState.rapidFailureCount + 1 : 1;
	const state = {
		channelId: input.channelId,
		generation: input.generation,
		stabilityStartedAt: continuesRapidFailureSequence ? previousState.stabilityStartedAt : undefined,
		rapidFailureCount,
	};

	return {
		state,
		action: rapidFailureCount > (input.maxRapidFailures ?? TRANSPORT_RECOVERY_MAX_RAPID_FAILURES) ? 'stop' : 'recover',
	};
};

const recordTransportRecoverySucceeded = ({
	state,
	transition,
}: {
	state: TTransportRecoveryCircuitState | undefined;
	transition: Extract<TTransportRecoveryTransition, { type: 'rebuild-succeeded' | 'reconnect-succeeded' }>;
}): TTransportRecoveryCircuitState | undefined => {
	if (
		state === undefined ||
		state.channelId !== transition.channelId ||
		(transition.type === 'rebuild-succeeded' && state.generation !== transition.generation)
	) {
		return state;
	}

	// A completed rebuild or WebSocket restore proves signaling setup, not
	// media health. Preserve the accumulated budget and start a new probation
	// interval; only surviving the complete server watchdog horizon earns a
	// fresh budget when a later failure is evaluated.
	return {
		...state,
		generation: transition.generation,
		stabilityStartedAt: transition.now,
	};
};

export type { TTransportFailureDispatchOutcome, TTransportRecoveryCircuitDecision, TTransportRecoveryCircuitState };
export {
	recordTransportRecoverySucceeded,
	resolveTransportFailureDispatchOutcome,
	resolveTransportRecoveryCircuitDecision,
	TRANSPORT_RECOVERY_MAX_RAPID_FAILURES,
	TRANSPORT_RECOVERY_STABILITY_MS,
};
