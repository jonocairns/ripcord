import { describe, expect, it } from 'bun:test';
import {
	cancelConsumeOperation,
	createConsumeOperationState,
	finishConsumeOperation,
	isCurrentConsumeOperation,
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

	it('supersedes an in-flight consume when its slot is cancelled by a stop-watch', () => {
		const state = createConsumeOperationState();

		const operation = reserveConsumeOperation(state, '10-screen');

		if (operation === undefined) {
			throw new Error('test setup failed to reserve consume operation');
		}

		// The consume RPC is mid-flight when the user presses Stop Watching.
		expect(isCurrentConsumeOperation(state, '10-screen', operation)).toBe(true);
		cancelConsumeOperation(state, '10-screen');

		// Every later guard in consumeOnce (before attach, before resume, before
		// success commit) must now see the operation as superseded and roll back.
		expect(isCurrentConsumeOperation(state, '10-screen', operation)).toBe(false);

		// Late completion of the cancelled operation is a no-op.
		finishConsumeOperation(state, '10-screen', operation);
		expect(reserveConsumeOperation(state, '10-screen')).toEqual({ generation: 0, token: 2 });
	});

	it('does not let a cancelled consume resurrect after a new watch reserves the slot', () => {
		const state = createConsumeOperationState();

		const cancelledOperation = reserveConsumeOperation(state, '10-screen');
		cancelConsumeOperation(state, '10-screen');
		const freshOperation = reserveConsumeOperation(state, '10-screen');

		expect(cancelledOperation).toBeDefined();
		expect(freshOperation).toBeDefined();

		if (cancelledOperation === undefined || freshOperation === undefined) {
			throw new Error('test setup failed to reserve consume operations');
		}

		expect(isCurrentConsumeOperation(state, '10-screen', cancelledOperation)).toBe(false);
		expect(isCurrentConsumeOperation(state, '10-screen', freshOperation)).toBe(true);

		// The cancelled operation finishing late must not clear the fresh one.
		finishConsumeOperation(state, '10-screen', cancelledOperation);
		expect(isCurrentConsumeOperation(state, '10-screen', freshOperation)).toBe(true);
	});
});
