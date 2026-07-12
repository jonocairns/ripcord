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
	for (let turn = 0; turn < 6; turn += 1) {
		await Promise.resolve();
	}
};

type TScheduledDelay = {
	dueAt: number;
	resolve: () => void;
	reject: (error: unknown) => void;
	signal: AbortSignal;
	handleAbort: () => void;
};

const createFakeScheduler = (initialNow = 0) => {
	let now = initialNow;
	const scheduledDelays: TScheduledDelay[] = [];

	const removeDelay = (delay: TScheduledDelay): void => {
		const index = scheduledDelays.indexOf(delay);
		if (index !== -1) {
			scheduledDelays.splice(index, 1);
		}
		delay.signal.removeEventListener('abort', delay.handleAbort);
	};

	return {
		now: (): number => now,
		delay: (milliseconds: number, signal: AbortSignal): Promise<void> =>
			new Promise((resolve, reject) => {
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}

				const delay: TScheduledDelay = {
					dueAt: now + milliseconds,
					resolve,
					reject,
					signal,
					handleAbort: () => {
						removeDelay(delay);
						reject(signal.reason);
					},
				};

				scheduledDelays.push(delay);
				signal.addEventListener('abort', delay.handleAbort, { once: true });
			}),
		advanceBy: async (milliseconds: number): Promise<void> => {
			now += milliseconds;
			const elapsedDelays = scheduledDelays.filter((delay) => delay.dueAt <= now);

			for (const delay of elapsedDelays) {
				removeDelay(delay);
				delay.resolve();
			}

			await flushMicrotasks();
		},
		pendingCount: (): number => scheduledDelays.length,
	};
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
	reportCommandError: () => {},
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

const startOnlineWait = (): Extract<TVoiceSessionCommand, { type: 'WaitOnline' }> => {
	const [snapshotCommand] = dispatchVoiceSession({
		type: 'WsDropped',
		pending: pendingReconnect,
		now: 0,
		online: false,
		authenticated: false,
	});

	if (snapshotCommand?.type !== 'CaptureRecoverySnapshot') {
		throw new Error('expected CaptureRecoverySnapshot command');
	}

	const [waitCommand] = dispatchVoiceSession({
		type: 'RecoveryStarted',
		commandId: snapshotCommand.commandId,
		generation: snapshotCommand.generation,
		snapshot: emptySnapshot,
	});

	if (waitCommand?.type !== 'WaitOnline') {
		throw new Error('expected WaitOnline command');
	}

	return waitCommand;
};

const startAuthWait = (): Extract<TVoiceSessionCommand, { type: 'WaitAuth' }> => {
	const [snapshotCommand] = dispatchVoiceSession({
		type: 'WsDropped',
		pending: pendingReconnect,
		now: 0,
		online: true,
		authenticated: false,
	});

	if (snapshotCommand?.type !== 'CaptureRecoverySnapshot') {
		throw new Error('expected CaptureRecoverySnapshot command');
	}

	const [waitCommand] = dispatchVoiceSession({
		type: 'RecoveryStarted',
		commandId: snapshotCommand.commandId,
		generation: snapshotCommand.generation,
		snapshot: emptySnapshot,
	});

	if (waitCommand?.type !== 'WaitAuth') {
		throw new Error('expected WaitAuth command');
	}

	return waitCommand;
};

const startRetryDelay = (pending = pendingReconnect): Extract<TVoiceSessionCommand, { type: 'RetryDelay' }> => {
	const [snapshotCommand] = dispatchVoiceSession({
		type: 'WsDropped',
		pending,
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

	const [retryCommand] = dispatchVoiceSession({
		type: 'RestoreFailed',
		commandId: restoreCommand.commandId,
		generation: restoreCommand.generation,
		error: new Error('network connection lost'),
	});

	if (retryCommand?.type !== 'RetryDelay') {
		throw new Error('expected RetryDelay command');
	}

	return retryCommand;
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
		let rebuildCalls = 0;
		const executor = createExecutor(
			createFakePorts({
				rebuildTransports: (command, context) => {
					rebuildCalls += 1;
					context.signal.addEventListener('abort', () => {
						abortedCommandIds.push(command.commandId);
					});

					return createDeferred<void>().promise;
				},
			}),
		);

		const rebuildCommand = startRebuild();

		executor.execute([rebuildCommand]);
		await flushMicrotasks();

		expect(rebuildCalls).toBe(1);
		expect(abortedCommandIds).toEqual([]);

		executor.dispose();

		expect(abortedCommandIds).toEqual([rebuildCommand.commandId]);

		// Disposed executors ignore further commands entirely.
		executor.execute([rebuildCommand]);
		await flushMicrotasks();

		expect(rebuildCalls).toBe(1);
	});

	it('runs a current final command and completes restore with the machine-defined result', async () => {
		let recoveredDesktopAudio = 0;
		const executor = createExecutor(
			createFakePorts({
				recoverDesktopAppAudio: () => {
					recoveredDesktopAudio += 1;
					return Promise.resolve();
				},
			}),
		);

		const rebuildCommand = startRebuild();
		const [recoverCommand] = dispatchVoiceSession({
			type: 'RebuildSucceeded',
			commandId: rebuildCommand.commandId,
			generation: rebuildCommand.generation,
		});

		if (recoverCommand?.type !== 'RecoverDesktopAppAudio') {
			throw new Error('expected RecoverDesktopAppAudio command');
		}

		executor.execute([recoverCommand]);
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

	it('does not execute a final command after its generation is invalidated', async () => {
		const rebuildCommand = startRebuild();
		const [recoverCommand] = dispatchVoiceSession({
			type: 'RebuildSucceeded',
			commandId: rebuildCommand.commandId,
			generation: rebuildCommand.generation,
		});

		if (recoverCommand?.type !== 'RecoverDesktopAppAudio') {
			throw new Error('expected RecoverDesktopAppAudio command');
		}

		dispatchVoiceSession({ type: 'JoinRequested', channelId: 9 });

		let recoveryCalls = 0;
		const executor = createExecutor(
			createFakePorts({
				recoverDesktopAppAudio: () => {
					recoveryCalls += 1;
					return Promise.resolve();
				},
			}),
		);

		executor.execute([recoverCommand]);
		await flushMicrotasks();

		expect(recoveryCalls).toBe(0);
	});

	it('flushes a buffered final command through the executor exactly once', async () => {
		const rebuildCommand = startRebuild();
		const [recoverCommand] = dispatchVoiceSession({
			type: 'RebuildSucceeded',
			commandId: rebuildCommand.commandId,
			generation: rebuildCommand.generation,
		});

		if (recoverCommand?.type !== 'RecoverDesktopAppAudio') {
			throw new Error('expected RecoverDesktopAppAudio command');
		}

		let recoveryCalls = 0;
		const executor = createExecutor(
			createFakePorts({
				recoverDesktopAppAudio: () => {
					recoveryCalls += 1;
					return Promise.resolve();
				},
			}),
		);
		const unregister = registerVoiceSessionCommandRunner(executor.execute);

		await flushMicrotasks();
		unregister();

		const unregisterNext = registerVoiceSessionCommandRunner(executor.execute);
		await flushMicrotasks();
		unregisterNext();

		expect(recoveryCalls).toBe(1);
	});

	it('reports final command failures and releases their bookkeeping', async () => {
		const rebuildCommand = startRebuild();
		const [recoverCommand] = dispatchVoiceSession({
			type: 'RebuildSucceeded',
			commandId: rebuildCommand.commandId,
			generation: rebuildCommand.generation,
		});

		if (recoverCommand?.type !== 'RecoverDesktopAppAudio') {
			throw new Error('expected RecoverDesktopAppAudio command');
		}

		const failure = new Error('desktop audio recovery failed');
		const reportedFailures: Array<{ command: TVoiceSessionCommand; error: unknown }> = [];
		let recoveryCalls = 0;
		const executor = createExecutor(
			createFakePorts({
				recoverDesktopAppAudio: () => {
					recoveryCalls += 1;
					return recoveryCalls === 1 ? Promise.reject(failure) : Promise.resolve();
				},
				reportCommandError: (command, error) => {
					reportedFailures.push({ command, error });
				},
			}),
		);

		executor.execute([recoverCommand]);
		await flushMicrotasks();
		executor.execute([recoverCommand]);
		await flushMicrotasks();

		expect(recoveryCalls).toBe(2);
		expect(reportedFailures).toEqual([{ command: recoverCommand, error: failure }]);
	});

	it('uses the failed session channel for leave and reports a rejected leave port', async () => {
		const rebuildCommand = startRebuild();
		const [leaveCommand] = dispatchVoiceSession({
			type: 'RebuildFailed',
			commandId: rebuildCommand.commandId,
			generation: rebuildCommand.generation,
			error: new Error('UnsupportedError: media codec not supported'),
		});

		if (leaveCommand?.type !== 'LeaveVoiceSession') {
			throw new Error('expected LeaveVoiceSession command');
		}

		const failure = new Error('leave failed');
		const channelIds: Array<number | undefined> = [];
		const reportedFailures: Array<{ command: TVoiceSessionCommand; error: unknown }> = [];
		const executor = createExecutor(
			createFakePorts({
				leaveVoiceSession: (channelId) => {
					channelIds.push(channelId);
					return Promise.reject(failure);
				},
				reportCommandError: (command, error) => {
					reportedFailures.push({ command, error });
				},
			}),
		);

		executor.execute([leaveCommand]);
		await flushMicrotasks();

		expect(channelIds).toEqual([5]);
		expect(reportedFailures).toEqual([{ command: leaveCommand, error: failure }]);
	});

	it('reports a rejected clear port without stranding executor bookkeeping', async () => {
		const [snapshotCommand] = dispatchVoiceSession({
			type: 'WsDropped',
			pending: pendingReconnect,
			now: 0,
			online: false,
			authenticated: false,
		});

		if (snapshotCommand?.type !== 'CaptureRecoverySnapshot') {
			throw new Error('expected CaptureRecoverySnapshot command');
		}

		const [waitCommand] = dispatchVoiceSession({
			type: 'RecoveryStarted',
			commandId: snapshotCommand.commandId,
			generation: snapshotCommand.generation,
			snapshot: emptySnapshot,
		});

		if (waitCommand?.type !== 'WaitOnline') {
			throw new Error('expected WaitOnline command');
		}

		const [clearCommand] = dispatchVoiceSession({
			type: 'OnlineExpired',
			commandId: waitCommand.commandId,
			generation: waitCommand.generation,
		});

		if (clearCommand?.type !== 'ClearFailedSession') {
			throw new Error('expected ClearFailedSession command');
		}

		const failure = new Error('clear failed');
		const reportedFailures: Array<{ command: TVoiceSessionCommand; error: unknown }> = [];
		let clearCalls = 0;
		const executor = createExecutor(
			createFakePorts({
				clearFailedSession: () => {
					clearCalls += 1;
					return clearCalls === 1 ? Promise.reject(failure) : Promise.resolve();
				},
				reportCommandError: (command, error) => {
					reportedFailures.push({ command, error });
				},
			}),
		);

		executor.execute([clearCommand]);
		await flushMicrotasks();
		executor.execute([clearCommand]);
		await flushMicrotasks();

		expect(clearCalls).toBe(2);
		expect(reportedFailures).toEqual([{ command: clearCommand, error: failure }]);
	});

	it('pauses an online wait while offline and resumes when connectivity returns', async () => {
		const scheduler = createFakeScheduler();
		let online = false;
		const waitCommand = startOnlineWait();
		const executor = createExecutor(
			createFakePorts({
				now: scheduler.now,
				delay: scheduler.delay,
				isOnline: () => online,
			}),
		);

		executor.execute([waitCommand]);
		expect(scheduler.pendingCount()).toBe(1);

		await scheduler.advanceBy(250);
		expect(getVoiceSessionState().phase).toMatchObject({ phase: 'reconnecting', step: 'waitingOnline' });

		online = true;
		await scheduler.advanceBy(250);

		expect(getVoiceSessionState().phase).toMatchObject({ phase: 'reconnecting', step: 'waitingAuth' });
		expect(scheduler.pendingCount()).toBe(0);
	});

	it('uses the live reconnect deadline after repeated websocket drops', async () => {
		const scheduler = createFakeScheduler();
		let online = false;
		const waitCommand = startOnlineWait();
		const executor = createExecutor(
			createFakePorts({
				now: scheduler.now,
				delay: scheduler.delay,
				isOnline: () => online,
			}),
		);

		executor.execute([waitCommand]);
		await scheduler.advanceBy(59_900);

		dispatchVoiceSession({
			type: 'WsDropped',
			pending: { ...pendingReconnect, expiresAt: 120_000 },
			now: scheduler.now(),
			online: false,
			authenticated: false,
		});
		await scheduler.advanceBy(100);

		expect(getVoiceSessionState().phase).toMatchObject({ phase: 'reconnecting', step: 'waitingOnline' });

		online = true;
		await scheduler.advanceBy(250);

		expect(getVoiceSessionState().phase).toMatchObject({ phase: 'reconnecting', step: 'waitingAuth' });
	});

	it('observes authentication immediately after subscribing without missing the update', async () => {
		const scheduler = createFakeScheduler();
		const waitCommand = startAuthWait();
		const executor = createExecutor(
			createFakePorts({
				now: scheduler.now,
				delay: scheduler.delay,
			}),
		);

		executor.execute([waitCommand]);
		expect(scheduler.pendingCount()).toBe(1);

		dispatchVoiceSession({ type: 'SocketAuthenticated' });
		await flushMicrotasks();

		expect(getVoiceSessionState().phase).toMatchObject({ phase: 'reconnecting', step: 'restoring' });
		expect(scheduler.pendingCount()).toBe(0);
	});

	it('cancels an auth wait on recovery clear or executor disposal without reporting failure', async () => {
		const scheduler = createFakeScheduler();
		const reportedFailures: unknown[] = [];
		const waitCommand = startAuthWait();
		const executor = createExecutor(
			createFakePorts({
				now: scheduler.now,
				delay: scheduler.delay,
				reportCommandError: (_command, error) => {
					reportedFailures.push(error);
				},
			}),
		);

		executor.execute([waitCommand]);
		dispatchVoiceSession({ type: 'RecoveryCleared', reason: 'logout' });
		await flushMicrotasks();

		expect(getVoiceSessionState().phase.phase).toBe('idle');
		expect(scheduler.pendingCount()).toBe(0);
		expect(reportedFailures).toEqual([]);

		resetVoiceSessionState();
		const resumedWaitCommand = startAuthWait();
		executor.execute([resumedWaitCommand]);
		expect(scheduler.pendingCount()).toBe(1);

		executor.dispose();
		await flushMicrotasks();

		expect(scheduler.pendingCount()).toBe(0);
		expect(reportedFailures).toEqual([]);
	});

	it('counts retry delay only while online', async () => {
		const scheduler = createFakeScheduler();
		let online = false;
		const retryCommand = startRetryDelay();
		const executor = createExecutor(
			createFakePorts({
				now: scheduler.now,
				random: () => 0.5,
				delay: scheduler.delay,
				isOnline: () => online,
			}),
		);

		executor.execute([retryCommand]);
		await scheduler.advanceBy(1_000);

		expect(getVoiceSessionState().phase).toMatchObject({ phase: 'reconnecting', step: 'retryDelay' });

		online = true;
		await scheduler.advanceBy(250);
		for (let elapsedOnlineMs = 0; elapsedOnlineMs < 1_000; elapsedOnlineMs += 250) {
			await scheduler.advanceBy(250);
		}

		expect(getVoiceSessionState().phase).toMatchObject({ phase: 'reconnecting', step: 'restoring' });
	});

	it('expires an offline retry delay at the live session deadline', async () => {
		const scheduler = createFakeScheduler();
		const retryCommand = startRetryDelay({ ...pendingReconnect, expiresAt: 500 });
		const executor = createExecutor(
			createFakePorts({
				now: scheduler.now,
				random: () => 0.5,
				delay: scheduler.delay,
				isOnline: () => false,
			}),
		);

		executor.execute([retryCommand]);
		await scheduler.advanceBy(500);

		expect(getVoiceSessionState().phase).toMatchObject({ phase: 'failed', reason: 'reconnect-expired' });
		expect(scheduler.pendingCount()).toBe(0);
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

	it('cannot resurrect a pre-reset operation into a post-reset session', async () => {
		const startedRebuilds: Array<Extract<TVoiceSessionCommand, { type: 'RebuildTransports' }>> = [];
		const rebuildDeferreds: Array<TDeferred<void>> = [];
		const abortedCommandIds: number[] = [];
		const executor = createExecutor(
			createFakePorts({
				rebuildTransports: (command, context) => {
					const deferred = createDeferred();

					startedRebuilds.push(command);
					rebuildDeferreds.push(deferred);
					context.signal.addEventListener('abort', () => {
						abortedCommandIds.push(command.commandId);
					});

					return deferred.promise;
				},
			}),
		);
		const unregister = registerVoiceSessionCommandRunner((commands) => {
			executor.execute(commands);
		});

		try {
			dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });

			const preResetRebuild = startedRebuilds[0];

			if (preResetRebuild === undefined) {
				throw new Error('expected a pre-reset RebuildTransports attempt');
			}

			// Reset notifies state-only listeners, so the executor aborts the pending
			// operation immediately rather than waiting for the next dispatch.
			resetVoiceSessionState();
			expect(abortedCommandIds).toEqual([preResetRebuild.commandId]);
			dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });

			const postResetRebuild = startedRebuilds[1];

			if (postResetRebuild === undefined) {
				throw new Error('expected a post-reset RebuildTransports attempt');
			}

			// Monotonic counters additionally guarantee the new session cannot reuse
			// the old identity if another long-lived operation misses reset itself.
			expect(postResetRebuild.generation).toBeGreaterThan(preResetRebuild.generation);
			expect(postResetRebuild.commandId).toBeGreaterThan(preResetRebuild.commandId);
			expect(abortedCommandIds).toEqual([preResetRebuild.commandId]);

			// The pre-reset attempt completing late must not advance the new session.
			const stateBeforeLateResult = getVoiceSessionState();
			let dispatchCount = 0;
			const unsubscribe = subscribeVoiceSession(() => {
				dispatchCount += 1;
			});

			try {
				rebuildDeferreds[0]?.resolve();
				await flushMicrotasks();

				expect(dispatchCount).toBe(0);
				expect(getVoiceSessionState()).toBe(stateBeforeLateResult);
			} finally {
				unsubscribe();
			}
		} finally {
			unregister();
		}
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
