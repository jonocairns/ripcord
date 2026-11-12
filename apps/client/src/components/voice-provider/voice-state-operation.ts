import type { TOwnVoiceIntent } from '@/features/server/voice/own-voice-state';

type TVoiceStateOperation = {
	operationToken: number;
	latestOperationToken: number;
};

const startVoiceStateOperation = (currentOperationToken: number): TVoiceStateOperation => {
	const nextOperationToken = currentOperationToken + 1;

	return {
		operationToken: nextOperationToken,
		latestOperationToken: nextOperationToken,
	};
};

const shouldApplyVoiceStateOperationResult = (operationToken: number, latestOperationToken: number) => {
	return operationToken === latestOperationToken;
};

type TVoiceStateOperationPorts = {
	setOwnVoiceIntent: (intent: Partial<TOwnVoiceIntent>) => void;
	cancelPushHold: () => void;
};

// Orders own voice-state mutations. User controls and terminal microphone loss
// share one sequence, so a late result cannot overwrite newer local intent.
// Construction is side-effect free and needs no media owner, so the provider
// builds it before the microphone and session runtime that commit terminal mute.
const createVoiceStateOperations = (ports: TVoiceStateOperationPorts) => {
	let latestOperationToken = 0;

	const begin = (): number => {
		const operation = startVoiceStateOperation(latestOperationToken);
		latestOperationToken = operation.latestOperationToken;
		return operation.operationToken;
	};

	const isCurrent = (operationToken: number): boolean =>
		shouldApplyVoiceStateOperationResult(operationToken, latestOperationToken);

	// The microphone mutes its own resources before calling this; only shared
	// state, reconnect intent and server synchronization are committed here.
	const commitTerminalMicMuted = (): void => {
		begin();
		ports.setOwnVoiceIntent({ micMuted: true });
		ports.cancelPushHold();
	};

	return { begin, isCurrent, commitTerminalMicMuted };
};

type TVoiceStateOperations = ReturnType<typeof createVoiceStateOperations>;

export {
	createVoiceStateOperations,
	shouldApplyVoiceStateOperationResult,
	startVoiceStateOperation,
	type TVoiceStateOperations,
};
