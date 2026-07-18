import type { TVoiceSessionPhase } from '@/features/server/voice/voice-session-machine';

const TRANSPORT_RECOVERY_MAX_RAPID_FAILURES = 3;
const TRANSPORT_RECOVERY_STABILITY_MS = 30_000;

type TTransportRecoveryCircuitState = {
	channelId: number;
	lastFailureAt: number;
	rapidFailureCount: number;
};

type TTransportRecoveryCircuitDecision = {
	state: TTransportRecoveryCircuitState;
	action: 'recover' | 'stop';
};

type TTransportFailureDispatchOutcome = {
	circuitState: TTransportRecoveryCircuitState | undefined;
	releaseLatch: boolean;
};

const resolveTransportFailureDispatchOutcome = ({
	circuitDecision,
	commandCount,
	phase,
	previousCircuitState,
}: {
	circuitDecision: TTransportRecoveryCircuitDecision;
	commandCount: number;
	phase: TVoiceSessionPhase['phase'];
	previousCircuitState: TTransportRecoveryCircuitState | undefined;
}): TTransportFailureDispatchOutcome => {
	const acceptedPhase = circuitDecision.action === 'stop' ? 'failed' : 'rebuilding';
	const releaseLatch = commandCount === 0 && phase !== acceptedPhase;

	return {
		circuitState: releaseLatch ? previousCircuitState : circuitDecision.state,
		releaseLatch,
	};
};

const resolveTransportRecoveryCircuitDecision = (input: {
	state: TTransportRecoveryCircuitState | undefined;
	channelId: number;
	now: number;
	maxRapidFailures?: number;
	stabilityMs?: number;
}): TTransportRecoveryCircuitDecision => {
	const stabilityMs = input.stabilityMs ?? TRANSPORT_RECOVERY_STABILITY_MS;
	const previousState = input.state;
	const continuesRapidFailureSequence =
		previousState !== undefined &&
		previousState.channelId === input.channelId &&
		input.now - previousState.lastFailureAt < stabilityMs;
	const rapidFailureCount = continuesRapidFailureSequence ? previousState.rapidFailureCount + 1 : 1;
	const state = {
		channelId: input.channelId,
		lastFailureAt: input.now,
		rapidFailureCount,
	};

	return {
		state,
		action: rapidFailureCount > (input.maxRapidFailures ?? TRANSPORT_RECOVERY_MAX_RAPID_FAILURES) ? 'stop' : 'recover',
	};
};

export type { TTransportFailureDispatchOutcome, TTransportRecoveryCircuitDecision, TTransportRecoveryCircuitState };
export {
	resolveTransportFailureDispatchOutcome,
	resolveTransportRecoveryCircuitDecision,
	TRANSPORT_RECOVERY_MAX_RAPID_FAILURES,
	TRANSPORT_RECOVERY_STABILITY_MS,
};
