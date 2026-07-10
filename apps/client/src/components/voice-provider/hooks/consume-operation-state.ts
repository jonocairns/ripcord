export type TConsumeOperationEntry = {
	generation: number;
	token: number;
};

export type TConsumeOperationState = {
	generation: number;
	operations: Map<string, TConsumeOperationEntry>;
	sequence: number;
};

export const createConsumeOperationState = (): TConsumeOperationState => ({
	generation: 0,
	operations: new Map(),
	sequence: 0,
});

export const resetConsumeOperationGeneration = (state: TConsumeOperationState): void => {
	state.operations.clear();
	state.generation += 1;
};

export const reserveConsumeOperation = (
	state: TConsumeOperationState,
	operationKey: string,
): TConsumeOperationEntry | undefined => {
	const existingOperation = state.operations.get(operationKey);

	if (existingOperation?.generation === state.generation) {
		return undefined;
	}

	if (existingOperation !== undefined) {
		state.operations.delete(operationKey);
	}

	state.sequence += 1;
	const operation: TConsumeOperationEntry = {
		generation: state.generation,
		token: state.sequence,
	};
	state.operations.set(operationKey, operation);

	return operation;
};

export const restartConsumeOperation = (
	state: TConsumeOperationState,
	operationKey: string,
): TConsumeOperationEntry => {
	state.sequence += 1;
	const operation: TConsumeOperationEntry = {
		generation: state.generation,
		token: state.sequence,
	};
	state.operations.set(operationKey, operation);

	return operation;
};

export const isCurrentConsumeOperation = (
	state: TConsumeOperationState,
	operationKey: string,
	operation: TConsumeOperationEntry,
): boolean => {
	const currentOperation = state.operations.get(operationKey);

	return currentOperation?.token === operation.token && currentOperation.generation === operation.generation;
};

// Invalidate any in-flight operation for the slot without reserving a new one.
// The running consume sees isCurrentConsumeOperation() flip false at its next
// guard and rolls back the local/server consumers it created — reserve/restart
// alone cannot do this for a revoked intent because nothing replaces the entry.
export const cancelConsumeOperation = (state: TConsumeOperationState, operationKey: string): void => {
	state.operations.delete(operationKey);
};

export const finishConsumeOperation = (
	state: TConsumeOperationState,
	operationKey: string,
	operation: TConsumeOperationEntry,
): void => {
	if (isCurrentConsumeOperation(state, operationKey, operation)) {
		state.operations.delete(operationKey);
	}
};
