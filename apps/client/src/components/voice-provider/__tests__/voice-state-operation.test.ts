import { describe, expect, it, mock } from 'bun:test';
import type { TVoiceUserState } from '@sharkord/shared';
import {
	createVoiceStateOperations,
	shouldApplyVoiceStateOperationResult,
	startVoiceStateOperation,
} from '../voice-state-operation';

const deferred = () => {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
};

const createHarness = ({ seated = true, reconnecting = false }: { seated?: boolean; reconnecting?: boolean } = {}) => {
	const sync = deferred();
	const ports = {
		getCurrentVoiceChannelId: () => (seated ? 5 : undefined),
		updateOwnVoiceState: mock((_state: Partial<TVoiceUserState>) => {}),
		updateReconnectIntent: mock((_state: Pick<TVoiceUserState, 'micMuted'>) => reconnecting),
		sendOwnVoiceStateUpdate: mock((_state: Pick<TVoiceUserState, 'micMuted'>) => sync.promise),
		log: mock((_message: string, _data?: Record<string, unknown>) => {}),
	};
	return { operations: createVoiceStateOperations(ports), ports, sync };
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
	it('terminal mute supersedes a user microphone operation awaiting its server update', () => {
		const h = createHarness();
		const userUnmute = h.operations.begin();
		void h.operations.commitTerminalMicMuted();
		// The pending unmute can no longer restart capture or fail closed over terminal mute.
		expect(h.operations.isCurrent(userUnmute)).toBe(false);
		expect(h.ports.updateOwnVoiceState).toHaveBeenCalledWith({ micMuted: true });
		expect(h.ports.updateReconnectIntent).toHaveBeenCalledWith({ micMuted: true });
		expect(h.ports.sendOwnVoiceStateUpdate).toHaveBeenCalledWith({ micMuted: true });
	});

	it('a later user action supersedes terminal mute and survives its failed synchronization', async () => {
		const h = createHarness();
		const terminal = h.operations.commitTerminalMicMuted();
		const userUnmute = h.operations.begin();
		const error = new Error('socket closed');
		h.sync.reject(error);
		await terminal;
		expect(h.operations.isCurrent(userUnmute)).toBe(true);
		expect(h.ports.updateOwnVoiceState).toHaveBeenCalledTimes(1);
		expect(h.ports.updateReconnectIntent).toHaveBeenCalledTimes(1);
		expect(h.ports.log).toHaveBeenCalledWith('Failed to synchronize terminal microphone mute', { error });
	});

	it.each([
		{ reconnecting: false, synchronized: false },
		{ reconnecting: true, synchronized: true },
	])('outside a seated channel synchronizes terminal mute only for reconnect intent: %o', async ({
		reconnecting,
		synchronized,
	}) => {
		const h = createHarness({ seated: false, reconnecting });
		h.sync.resolve();
		await h.operations.commitTerminalMicMuted();
		expect(h.ports.updateOwnVoiceState).toHaveBeenCalledWith({ micMuted: true });
		expect(h.ports.updateReconnectIntent).toHaveBeenCalledWith({ micMuted: true });
		expect(h.ports.sendOwnVoiceStateUpdate).toHaveBeenCalledTimes(synchronized ? 1 : 0);
	});
});
