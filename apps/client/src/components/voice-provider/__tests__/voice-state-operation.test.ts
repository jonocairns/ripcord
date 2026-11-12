import { describe, expect, it, mock } from 'bun:test';
import {
	createVoiceStateOperations,
	shouldApplyVoiceStateOperationResult,
	startVoiceStateOperation,
} from '../voice-state-operation';

const createHarness = () => {
	const ports = {
		setOwnVoiceIntent: mock((_intent: { micMuted?: boolean; soundMuted?: boolean }) => {}),
		cancelPushHold: mock(() => {}),
	};
	return { operations: createVoiceStateOperations(ports), ports };
};

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

describe('voice state operations', () => {
	it('synchronously cancels holds and commits mute while invalidating older work', () => {
		const h = createHarness();
		const old = h.operations.begin();
		h.operations.commitTerminalMicMuted();
		expect(h.operations.isCurrent(old)).toBe(false);
		expect(h.ports.setOwnVoiceIntent).toHaveBeenCalledWith({ micMuted: true });
		expect(h.ports.cancelPushHold).toHaveBeenCalledTimes(1);
		const newer = h.operations.begin();
		expect(h.operations.isCurrent(newer)).toBe(true);
	});
});
