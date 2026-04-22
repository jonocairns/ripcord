import { describe, expect, it } from 'bun:test';
import { shouldApplyVoiceStateOperationResult, startVoiceStateOperation } from '../voice-state-operation';

describe('voice state operation ordering', () => {
	it('creates monotonically increasing operation tokens', () => {
		const firstOperation = startVoiceStateOperation(0);
		const secondOperation = startVoiceStateOperation(firstOperation.latestOperationToken);

		expect(firstOperation).toEqual({
			operationToken: 1,
			latestOperationToken: 1,
		});
		expect(secondOperation).toEqual({
			operationToken: 2,
			latestOperationToken: 2,
		});
	});

	it('allows the latest async result to apply', () => {
		const operation = startVoiceStateOperation(0);

		expect(shouldApplyVoiceStateOperationResult(operation.operationToken, operation.latestOperationToken)).toBe(true);
	});

	it('ignores an older async result after a newer operation starts', () => {
		const quickPressOperation = startVoiceStateOperation(0);
		const quickReleaseOperation = startVoiceStateOperation(quickPressOperation.latestOperationToken);

		expect(
			shouldApplyVoiceStateOperationResult(
				quickPressOperation.operationToken,
				quickReleaseOperation.latestOperationToken,
			),
		).toBe(false);
		expect(
			shouldApplyVoiceStateOperationResult(
				quickReleaseOperation.operationToken,
				quickReleaseOperation.latestOperationToken,
			),
		).toBe(true);
	});
});
