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

export type { TTransportRecoveryCircuitDecision, TTransportRecoveryCircuitState };
export {
	resolveTransportRecoveryCircuitDecision,
	TRANSPORT_RECOVERY_MAX_RAPID_FAILURES,
	TRANSPORT_RECOVERY_STABILITY_MS,
};
