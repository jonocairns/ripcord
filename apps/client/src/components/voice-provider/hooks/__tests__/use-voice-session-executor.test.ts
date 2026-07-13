import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { TVoiceSessionExecutorPorts } from '@/features/server/voice/voice-session-command-executor';
import type {
	TVoiceSessionCommand,
	TWatchedRemoteStreamsSnapshot,
} from '@/features/server/voice/voice-session-machine';
import {
	dispatchVoiceSession,
	getVoiceSessionState,
	resetVoiceSessionState,
} from '@/features/server/voice/voice-session-store';
import { mountVoiceSessionExecutor } from '../use-voice-session-executor';

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
	for (let turn = 0; turn < 8; turn += 1) {
		await Promise.resolve();
	}
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
	reportRebuildDetached: () => {},
	reportRebuildTerminalFailure: () => {},
	reportRestoreDetached: () => {},
	...overrides,
});

const startRestoreWithNoRunner = (): void => {
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
};

const bufferDesktopAudioRecovery = (): void => {
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

	dispatchVoiceSession({
		type: 'RebuildSucceeded',
		commandId: rebuildCommand.commandId,
		generation: rebuildCommand.generation,
	});
};

describe('voice session executor adapter', () => {
	const unmounts: Array<() => void> = [];

	beforeEach(() => {
		resetVoiceSessionState();
	});

	afterEach(() => {
		for (const unmount of unmounts) {
			unmount();
		}

		unmounts.length = 0;
	});

	it('keeps one mounted executor while ref-backed dependencies change and disposes it once', async () => {
		const rebuild = createDeferred<void>();
		let oldRebuildCalls = 0;
		let latestRebuildCalls = 0;
		let abortCount = 0;
		let ports = createFakePorts({
			rebuildTransports: () => {
				oldRebuildCalls += 1;
				return Promise.resolve();
			},
		});
		const unmount = mountVoiceSessionExecutor(() => ports);
		unmounts.push(unmount);

		ports = createFakePorts({
			rebuildTransports: (_command, context) => {
				latestRebuildCalls += 1;
				context.signal.addEventListener('abort', () => {
					abortCount += 1;
				});
				return rebuild.promise;
			},
		});

		dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });
		await flushMicrotasks();

		expect(oldRebuildCalls).toBe(0);
		expect(latestRebuildCalls).toBe(1);

		unmount();
		unmount();

		expect(abortCount).toBe(1);
		expect(latestRebuildCalls).toBe(1);
	});

	it('replays an interrupted rebuild on remount and ignores its disposal failure', async () => {
		const oldRebuild = createDeferred<void>();
		const newRebuild = createDeferred<void>();
		const reportedErrors: unknown[] = [];
		let oldCommand: Extract<TVoiceSessionCommand, { type: 'RebuildTransports' }> | undefined;
		let newCommand: Extract<TVoiceSessionCommand, { type: 'RebuildTransports' }> | undefined;
		let recoveredDesktopAudio = 0;
		const oldPorts = createFakePorts({
			rebuildTransports: (command, context) => {
				oldCommand = command;
				context.signal.addEventListener('abort', () => {
					oldRebuild.reject(new Error('old rebuild aborted'));
				});
				return oldRebuild.promise;
			},
			reportCommandError: (_command, error) => {
				reportedErrors.push(error);
			},
		});
		const unmountOld = mountVoiceSessionExecutor(() => oldPorts);

		dispatchVoiceSession({ type: 'TransportFailed', channelId: 5, nonce: 1 });
		await flushMicrotasks();
		unmountOld();
		await flushMicrotasks();

		const newPorts = createFakePorts({
			rebuildTransports: (command) => {
				newCommand = command;
				return newRebuild.promise;
			},
			recoverDesktopAppAudio: () => {
				recoveredDesktopAudio += 1;
				return Promise.resolve();
			},
			reportCommandError: (_command, error) => {
				reportedErrors.push(error);
			},
		});
		const unmountNew = mountVoiceSessionExecutor(() => newPorts);
		unmounts.push(unmountNew);
		await flushMicrotasks();

		expect(oldCommand).toBeDefined();
		expect(newCommand).toBeDefined();
		expect(newCommand?.generation).toBeGreaterThan(oldCommand?.generation ?? 0);
		expect(getVoiceSessionState().phase).toMatchObject({
			phase: 'rebuilding',
			generation: newCommand?.generation,
		});
		expect(reportedErrors).toEqual([]);

		newRebuild.resolve();
		await flushMicrotasks();

		expect(getVoiceSessionState().phase.phase).toBe('connected');
		expect(recoveredDesktopAudio).toBe(1);
	});

	it('replays an interrupted restore on remount and ignores its disposal failure', async () => {
		startRestoreWithNoRunner();
		const oldRestore = createDeferred<{ serverSessionEstablished: boolean }>();
		const newRestore = createDeferred<{ serverSessionEstablished: boolean }>();
		const reportedErrors: unknown[] = [];
		let oldCommand: Extract<TVoiceSessionCommand, { type: 'RestoreVoiceSession' }> | undefined;
		let newCommand: Extract<TVoiceSessionCommand, { type: 'RestoreVoiceSession' }> | undefined;
		let restoredWatchIntent = 0;
		const oldPorts = createFakePorts({
			restoreVoiceSession: (command, context) => {
				oldCommand = command;
				context.signal.addEventListener('abort', () => {
					oldRestore.reject(new Error('old restore aborted'));
				});
				return oldRestore.promise;
			},
			reportCommandError: (_command, error) => {
				reportedErrors.push(error);
			},
		});
		const unmountOld = mountVoiceSessionExecutor(() => oldPorts);
		await flushMicrotasks();
		unmountOld();
		await flushMicrotasks();

		const newPorts = createFakePorts({
			restoreVoiceSession: (command) => {
				newCommand = command;
				return newRestore.promise;
			},
			restoreWatchIntent: () => {
				restoredWatchIntent += 1;
			},
			reportCommandError: (_command, error) => {
				reportedErrors.push(error);
			},
		});
		const unmountNew = mountVoiceSessionExecutor(() => newPorts);
		unmounts.push(unmountNew);
		await flushMicrotasks();

		expect(oldCommand).toBeDefined();
		expect(newCommand).toBeDefined();
		expect(newCommand?.generation).toBeGreaterThan(oldCommand?.generation ?? 0);
		expect(getVoiceSessionState().phase).toMatchObject({
			phase: 'reconnecting',
			step: 'restoring',
			generation: newCommand?.generation,
		});
		expect(reportedErrors).toEqual([]);

		newRestore.resolve({ serverSessionEstablished: true });
		await flushMicrotasks();

		expect(getVoiceSessionState().phase.phase).toBe('connected');
		expect(restoredWatchIntent).toBe(1);
	});

	it('flushes a generation-valid final command once and drops one invalidated during a runner gap', async () => {
		bufferDesktopAudioRecovery();
		let recoveryCalls = 0;
		const ports = createFakePorts({
			recoverDesktopAppAudio: () => {
				recoveryCalls += 1;
				return Promise.resolve();
			},
		});
		const unmountFirst = mountVoiceSessionExecutor(() => ports);
		unmountFirst();
		const unmountSecond = mountVoiceSessionExecutor(() => ports);
		unmountSecond();
		await flushMicrotasks();

		expect(recoveryCalls).toBe(1);

		resetVoiceSessionState();
		bufferDesktopAudioRecovery();
		dispatchVoiceSession({ type: 'RecoveryCleared', reason: 'logout' });
		const unmountAfterInvalidation = mountVoiceSessionExecutor(() => ports);
		unmounts.push(unmountAfterInvalidation);
		await flushMicrotasks();

		expect(recoveryCalls).toBe(1);
	});
});
