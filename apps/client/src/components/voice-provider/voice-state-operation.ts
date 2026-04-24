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

export { shouldApplyVoiceStateOperationResult, startVoiceStateOperation };
