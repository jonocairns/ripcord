import type { TVoiceUserState } from '@sharkord/shared';

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
	getCurrentVoiceChannelId: () => number | undefined;
	updateOwnVoiceState: (state: Partial<TVoiceUserState>) => void;
	updateReconnectIntent: (state: Pick<TVoiceUserState, 'micMuted'>) => boolean;
	sendOwnVoiceStateUpdate: (state: Pick<TVoiceUserState, 'micMuted'>) => Promise<unknown>;
	log: (message: string, data?: Record<string, unknown>) => void;
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
	const commitTerminalMicMuted = async (): Promise<void> => {
		const currentVoiceChannelId = ports.getCurrentVoiceChannelId();
		begin();

		ports.updateOwnVoiceState({ micMuted: true });
		const updatedReconnectIntent = ports.updateReconnectIntent({ micMuted: true });

		if (currentVoiceChannelId === undefined && !updatedReconnectIntent) {
			return;
		}

		try {
			await ports.sendOwnVoiceStateUpdate({ micMuted: true });
		} catch (error) {
			// Terminal capture loss is locally authoritative. The reconnect intent
			// carries this state to restore, and a later user operation is sequenced
			// after this best-effort synchronization.
			ports.log('Failed to synchronize terminal microphone mute', { error });
		}
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
