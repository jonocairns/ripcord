export class VoiceSessionExecutionSupersededError extends Error {
	constructor() {
		super('Voice session execution superseded');
		this.name = 'VoiceSessionExecutionSupersededError';
	}
}

export type TVoiceSessionExecutionOwnership = {
	epoch: number;
};

export const createVoiceSessionExecutionOwnership = (): TVoiceSessionExecutionOwnership => ({ epoch: 0 });

export const invalidateVoiceSessionExecution = (ownership: TVoiceSessionExecutionOwnership): void => {
	ownership.epoch += 1;
};

export const claimVoiceSessionExecution = (ownership: TVoiceSessionExecutionOwnership): (() => boolean) => {
	ownership.epoch += 1;
	const epoch = ownership.epoch;

	return () => ownership.epoch === epoch;
};
