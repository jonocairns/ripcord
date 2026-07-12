import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	createVoiceSessionCommandExecutor,
	type TVoiceSessionCommandExecutor,
	type TVoiceSessionExecutorPorts,
} from '../voice-session-command-executor';
import {
	type TVoiceSessionCommand,
	type TWatchedRemoteStreamsSnapshot,
	VOICE_RECONNECT_SUPPRESSION_MS,
} from '../voice-session-machine';
import {
	dispatchVoiceSession,
	getVoiceSessionState,
	registerVoiceSessionCommandRunner,
	resetVoiceSessionState,
	subscribeVoiceSession,
} from '../voice-session-store';

// Deterministic harness: no real timers, browser globals, React renderer, RPC
// client, or mediasoup mock. Time and every recovery operation are injected
// fakes; the machine/store are driven directly with dispatched events.

const emptySnapshot: TWatchedRemoteStreamsSnapshot = { remoteUserStreams: {}, externalStreams: {} };

const pendingReconnect = {
	channelId: 5,
	micMuted: false,
	soundMuted: false,
	peerUserIds: [10],
	expiresAt: 60_000,
};

type TDeferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

const createDeferred = <T = void>(): TDeferred<T> => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});

	return { promise, resolve, reject };
};

const flushMicrotasks = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

const createFakePorts = (overrides: Partial<TVoiceSessionExecutorPorts> = {}): TVoiceSessionExecutorPorts => ({
	now: () => 1_000,
	random: () => 0.5,
	delay: () => Promise.resolve(),
	isOnline: () => true,
	captureRecoverySnapshot: () => emptySnapshot,
	rebuildTransports: () => Promise.resolve(),
	restoreVoiceSession: () => Promise.resolve({ serverSessionEstablished: true }),
	restoreWatchIntent: () => {},
	recoverDesktopAppAudio: () => Promise.resolve(),
	leaveVoiceSession: () => Promise.resolve(),
	clearFailedSession: () => Promise.resolve(),
	...overrides,
});

// Drives the machine to a live RebuildTransports command without any runner
// registered, returning the command so tests control when/how it executes.
const startRebuild = (): Extract<TVoiceSessionCommand, { type: 'RebuildTransports' }> => {
	const [snapshotCommand] = dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });

	if (snapshotCommand?.type !== 'CaptureRecoverySnapshot') {
		throw new Error('expected CaptureRecoverySnapshot command');
	}

	const [rebuildCommand] = dispatchVoiceSession({
		type: 'RecoveryStarted',
		commandId: snapshotCommand.commandId,
		generation: snapshotCommand.generation,
		snapshot: emptySnapshot,
	});

	if (rebuildCommand?.type !== 'RebuildTransports') {
		throw new Error('expected RebuildTransports command');
	}

	return rebuildCommand;
};

// Drives the machine to a live RestoreVoiceSession command (reconnecting,
// online, authenticated) without any runner registered.
const startRestore = (): Extract<TVoiceSessionCommand, { type: 'RestoreVoiceSession' }> => {
	const [snapshotCommand] = dispatchVoiceSession({
		type: 'WsDropped',
		pending: pendingReconnect,
		now: 0,
		online: true,
		authenticated: true,
	});

	if (snapshotCommand?.type !== 'CaptureRecoverySnapshot') {
		throw new Error('expected CaptureRecoverySnapshot command');
	}

	const [restoreCommand] = dispatchVoiceSession({
		type: 'RecoveryStarted',
		commandId: snapshotCommand.commandId,
		generation: snapshotCommand.generation,
		snapshot: emptySnapshot,
	});

	if (restoreCommand?.type !== 'RestoreVoiceSession') {
		throw new Error('expected RestoreVoiceSession command');
	}

	return restoreCommand;
};

describe('voice session command executor', () => {
	const executors: TVoiceSessionCommandExecutor[] = [];

	const createExecutor = (ports: TVoiceSessionExecutorPorts): TVoiceSessionCommandExecutor => {
		const executor = createVoiceSessionCommandExecutor(ports);

		executors.push(executor);

		return executor;
	};

	beforeEach(() => {
		resetVoiceSessionState();
	});

	afterEach(() => {
		for (const executor of executors) {
			executor.dispose();
		}

		executors.length = 0;
	});

	it('executes a current snapshot command and dispatches RecoveryStarted with the same command identity', () => {
		const [snapshotCommand] = dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });

		if (snapshotCommand?.type !== 'CaptureRecoverySnapshot') {
			throw new Error('expected CaptureRecoverySnapshot command');
		}

		const executor = createExecutor(createFakePorts());

		executor.execute([snapshotCommand]);

		const { phase } = getVoiceSessionState();

		expect(phase.phase).toBe('rebuilding');
		if (phase.phase !== 'rebuilding') return;
		expect(phase.snapshot).toEqual(emptySnapshot);
	});

	it('does not start a stale command', () => {
		const rebuildCommand = startRebuild();

		// The machine moved on before the command could run (terminal teardown).
		dispatchVoiceSession({ type: 'Terminated', reason: 'kicked', channelId: 5 });

		let rebuildCalls = 0;
		const executor = createExecutor(
			createFakePorts({
				rebuildTransports: () => {
					rebuildCalls += 1;
					return Promise.resolve();
				},
			}),
		);

		executor.execute([rebuildCommand]);

		expect(rebuildCalls).toBe(0);
	});

	it('aborts a superseded command before the superseding command starts its effect', () => {
		const order: string[] = [];
		const startedRebuilds: Array<Extract<TVoiceSessionCommand, { type: 'RebuildTransports' }>> = [];
		const executor = createExecutor(
			createFakePorts({
				rebuildTransports: (command, context) => {
					order.push(`start:${command.commandId}`);
					startedRebuilds.push(command);
					context.signal.addEventListener('abort', () => {
						order.push(`abort:${command.commandId}`);
					});

					return createDeferred<void>().promise;
				},
			}),
		);
		const unregister = registerVoiceSessionCommandRunner((commands) => {
			executor.execute(commands);
		});

		try {
			// With the executor registered as the runner, TransportFailed flows
			// snapshot capture -> RecoveryStarted -> RebuildTransports on its own.
			dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });

			const firstRebuild = startedRebuilds[0];

			if (firstRebuild === undefined) {
				throw new Error('expected an initial RebuildTransports attempt');
			}

			// A nonce change supersedes the in-flight rebuild with a fresh command.
			// The executor's store subscription must abort the old operation during
			// the dispatch, before the new command is delivered to the runner.
			const [secondRebuild] = dispatchVoiceSession({
				type: 'NonceChanged',
				commandId: firstRebuild.commandId,
				generation: firstRebuild.generation,
				nonce: 2,
			});

			if (secondRebuild?.type !== 'RebuildTransports') {
				throw new Error('expected superseding RebuildTransports command');
			}

			expect(order).toEqual([
				`start:${firstRebuild.commandId}`,
				`abort:${firstRebuild.commandId}`,
				`start:${secondRebuild.commandId}`,
			]);
		} finally {
			unregister();
		}
	});

	it('ignores a late result from an aborted command', async () => {
		const rebuildDeferreds: Array<TDeferred<void>> = [];
		const startedRebuilds: Array<Extract<TVoiceSessionCommand, { type: 'RebuildTransports' }>> = [];
		const executor = createExecutor(
			createFakePorts({
				rebuildTransports: (command) => {
					const deferred = createDeferred();

					startedRebuilds.push(command);
					rebuildDeferreds.push(deferred);

					return deferred.promise;
				},
			}),
		);
		const unregister = registerVoiceSessionCommandRunner((commands) => {
			executor.execute(commands);
		});

		try {
			// Supersede twice so both aborted attempts (the first and the second)
			// are free to settle late while the third is the active command. With
			// the executor registered as the runner, TransportFailed reaches
			// RebuildTransports on its own via the snapshot round trip.
			dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });

			const firstRebuild = startedRebuilds[0];

			if (firstRebuild === undefined) {
				throw new Error('expected an initial RebuildTransports attempt');
			}

			dispatchVoiceSession({
				type: 'NonceChanged',
				commandId: firstRebuild.commandId,
				generation: firstRebuild.generation,
				nonce: 2,
			});

			const secondRebuild = startedRebuilds[1];

			if (secondRebuild === undefined) {
				throw new Error('expected a superseding RebuildTransports attempt');
			}

			dispatchVoiceSession({
				type: 'NonceChanged',
				commandId: secondRebuild.commandId,
				generation: secondRebuild.generation,
				nonce: 3,
			});

			expect(startedRebuilds).toHaveLength(3);

			const stateBeforeLateResults = getVoiceSessionState();
			let dispatchCount = 0;
			const unsubscribe = subscribeVoiceSession(() => {
				dispatchCount += 1;
			});

			try {
				// The aborted attempts settle late — one successfully, one with an
				// error. Neither may produce a RebuildSucceeded/RebuildFailed
				// dispatch, and the third attempt must stay the active command.
				rebuildDeferreds[0]?.resolve();
				rebuildDeferreds[1]?.reject(new Error('late failure from aborted attempt'));
				await flushMicrotasks();

				expect(dispatchCount).toBe(0);
				expect(getVoiceSessionState()).toBe(stateBeforeLateResults);
			} finally {
				unsubscribe();
			}
		} finally {
			unregister();
		}
	});

	it('dispose aborts all active command signals and stops executing new commands', async () => {
		const abortedCommandIds: number[] = [];
		let leaveCalls = 0;
		const executor = createExecutor(
			createFakePorts({
				rebuildTransports: (command, context) => {
					context.signal.addEventListener('abort', () => {
						abortedCommandIds.push(command.commandId);
					});

					return createDeferred<void>().promise;
				},
				leaveVoiceSession: () => {
					leaveCalls += 1;
					return createDeferred<void>().promise;
				},
			}),
		);

		const rebuildCommand = startRebuild();
		// Final commands never carry machine currency, so one stays active
		// alongside the recovery step without the store sweep cancelling it.
		const leaveCommand: TVoiceSessionCommand = {
			type: 'LeaveVoiceSession',
			commandId: 99,
			generation: rebuildCommand.generation,
			channelId: 5,
		};

		executor.execute([rebuildCommand, leaveCommand]);
		await flushMicrotasks();

		expect(leaveCalls).toBe(1);
		expect(abortedCommandIds).toEqual([]);

		executor.dispose();

		expect(abortedCommandIds).toEqual([rebuildCommand.commandId]);

		// Disposed executors ignore further commands entirely.
		executor.execute([
			{ type: 'LeaveVoiceSession', commandId: 100, generation: rebuildCommand.generation, channelId: 5 },
		]);
		await flushMicrotasks();

		expect(leaveCalls).toBe(1);
	});

	it('runs final commands without machine currency and completes restore with the machine-defined result', async () => {
		let recoveredDesktopAudio = 0;
		const executor = createExecutor(
			createFakePorts({
				recoverDesktopAppAudio: () => {
					recoveredDesktopAudio += 1;
					return Promise.resolve();
				},
			}),
		);

		// Hand-crafted final command: currency is always false for finals, so the
		// executor must not stale-reject it.
		executor.execute([{ type: 'RecoverDesktopAppAudio', commandId: 42, generation: 7 }]);
		await flushMicrotasks();

		expect(recoveredDesktopAudio).toBe(1);

		const restoreCommand = startRestore();
		const restoreExecutor = createExecutor(
			createFakePorts({
				restoreVoiceSession: () => Promise.resolve({ serverSessionEstablished: true }),
			}),
		);

		restoreExecutor.execute([restoreCommand]);
		await flushMicrotasks();

		const { phase } = getVoiceSessionState();

		expect(phase.phase).toBe('reconnecting');
		if (phase.phase !== 'reconnecting') return;
		expect(phase.step).toBe('restoreWatch');
		expect(phase.serverSessionEstablished).toBe(true);
	});

	it('uses the injected clock for WatchIntentRehydrated instead of Date.now', async () => {
		const restoreCommand = startRestore();
		const [watchCommand] = dispatchVoiceSession({
			type: 'RestoreSucceeded',
			commandId: restoreCommand.commandId,
			generation: restoreCommand.generation,
			serverSessionEstablished: true,
		});

		if (watchCommand?.type !== 'RestoreWatchIntent') {
			throw new Error('expected RestoreWatchIntent command');
		}

		const rehydratedSnapshots: TWatchedRemoteStreamsSnapshot[] = [];
		const executor = createExecutor(
			createFakePorts({
				now: () => 123,
				restoreWatchIntent: (snapshot) => {
					rehydratedSnapshots.push(snapshot);
				},
			}),
		);

		executor.execute([watchCommand]);
		await flushMicrotasks();

		expect(rehydratedSnapshots).toEqual([emptySnapshot]);

		const state = getVoiceSessionState();

		expect(state.phase.phase).toBe('connected');
		expect(state.suppression).toEqual({
			channelId: pendingReconnect.channelId,
			peerUserIds: pendingReconnect.peerUserIds,
			expiresAt: 123 + VOICE_RECONNECT_SUPPRESSION_MS,
		});
	});

	it('dispatches RebuildFailed with the raw error only while the command is current', async () => {
		const rebuildCommand = startRebuild();
		const failure = new Error('transport rebuild exploded');
		const deferred = createDeferred<void>();
		const executor = createExecutor(
			createFakePorts({
				rebuildTransports: () => deferred.promise,
			}),
		);

		executor.execute([rebuildCommand]);

		const observedErrors: unknown[] = [];
		const unsubscribe = subscribeVoiceSession((state) => {
			if (state.phase.phase === 'rebuilding') {
				observedErrors.push('retry-scheduled');
			}
		});

		try {
			deferred.reject(failure);
			await flushMicrotasks();
		} finally {
			unsubscribe();
		}

		// The reducer received RebuildFailed (unknown error → retry with a new
		// RebuildTransports command), proving the raw error reached the machine
		// unclassified.
		const { phase } = getVoiceSessionState();

		expect(observedErrors).toEqual(['retry-scheduled']);
		expect(phase.phase).toBe('rebuilding');
		if (phase.phase !== 'rebuilding') return;
		expect(phase.attempt).toBe(1);
	});
});
