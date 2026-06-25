import { describe, expect, it } from 'bun:test';
import {
	createConsumeOperationState,
	finishConsumeOperation,
	reserveConsumeOperation,
	resetConsumeOperationGeneration,
} from '../hooks/consume-operation-state';

describe('consume operation state', () => {
	it('dedups consume operations within the active transport generation', () => {
		const state = createConsumeOperationState();

		const operation = reserveConsumeOperation(state, '10-audio');

		expect(operation).toEqual({ generation: 0, token: 1 });
		expect(reserveConsumeOperation(state, '10-audio')).toBeUndefined();
	});

	it('does not let a stale consume operation block a new transport generation', () => {
		const state = createConsumeOperationState();

		const staleOperation = reserveConsumeOperation(state, '10-audio');
		resetConsumeOperationGeneration(state);
		const freshOperation = reserveConsumeOperation(state, '10-audio');

		expect(staleOperation).toEqual({ generation: 0, token: 1 });
		expect(freshOperation).toEqual({ generation: 1, token: 2 });
	});

	it('ignores stale completion after a newer operation has been reserved', () => {
		const state = createConsumeOperationState();

		const staleOperation = reserveConsumeOperation(state, '10-audio');
		resetConsumeOperationGeneration(state);
		const freshOperation = reserveConsumeOperation(state, '10-audio');

		expect(staleOperation).toBeDefined();
		expect(freshOperation).toBeDefined();

		if (staleOperation === undefined || freshOperation === undefined) {
			throw new Error('test setup failed to reserve consume operations');
		}

		finishConsumeOperation(state, '10-audio', staleOperation);
		expect(reserveConsumeOperation(state, '10-audio')).toBeUndefined();

		finishConsumeOperation(state, '10-audio', freshOperation);
		expect(reserveConsumeOperation(state, '10-audio')).toEqual({ generation: 1, token: 3 });
	});
});
