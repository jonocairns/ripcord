import { getVoiceReconnectRetryDelayMs, VoiceReconnectTimeoutError } from './reconnect-policy';
import {
	selectReconnectAuthenticated,
	selectReconnectingSince,
	type TVoiceSessionCommand,
	type TVoiceSessionState,
	type TWatchedRemoteStreamsSnapshot,
} from './voice-session-machine';
import {
	dispatchVoiceSession,
	isFinalVoiceSessionCommandCurrent,
	isVoiceSessionCommandCurrent,
	selectVoiceSessionState,
	subscribeVoiceSessionState,
} from './voice-session-store';

// The voice session command executor owns the asynchronous lifecycle of
// machine-emitted commands: per-command AbortControllers, stale-command
// rejection, supersession-driven cancellation, and result-event dispatch. It
// deliberately imports nothing from React, Zustand, mediasoup, browser
// globals, or the reconnect facade — time, randomness, waiting, connectivity,
// and every concrete recovery operation arrive through injected ports, so the
// whole lifecycle is testable without real timers or media stacks.
//
// The VoiceProvider React adapter registers this executor directly for every
// command and supplies live concrete capabilities through ref-backed ports.

type TRebuildTransportsCommand = Extract<TVoiceSessionCommand, { type: 'RebuildTransports' }>;
type TRestoreVoiceSessionCommand = Extract<TVoiceSessionCommand, { type: 'RestoreVoiceSession' }>;
type TClearFailedSessionCommand = Extract<TVoiceSessionCommand, { type: 'ClearFailedSession' }>;

type TVoiceSessionCommandContext = {
	// Aborted when the command is superseded, the machine leaves the command's
	// step, or the executor is disposed. Ports must stop mutating shared state
	// once this fires; cancellation never waits on the port to acknowledge.
	signal: AbortSignal;
	// Must be re-checked after every awaited boundary and before every shared
	// write. For recovery-step commands this reads live machine currency; for
	// final commands (which the machine never marks current) it only reflects
	// abort/disposal.
	isCurrent: () => boolean;
};

type TVoiceSessionRestoreContext = TVoiceSessionCommandContext & {
	// Restore ports wrap each RPC/media boundary so timeout and cancellation
	// orchestration remain executor-owned. The executor tracks the underlying
	// operation separately, allowing it to drain briefly and then detach a hung
	// cancelled boundary without blocking a queued retry forever.
	withTimeout: <T>(operation: Promise<T>) => Promise<T>;
	// Called immediately after restoreOrJoin returns. Ownership is sticky for the
	// rest of the command, including later initialization failures.
	markServerSessionEstablished: () => void;
};

type TVoiceSessionRebuildContext = TVoiceSessionCommandContext & {
	// Concrete media code observes the provider's live reconnect nonce after
	// awaited boundaries. The executor owns the machine handoff so the port never
	// dispatches session events itself. True means the operation must stop because
	// it was stale or a replacement command was issued.
	restartIfNonceChanged: (currentNonce: number) => boolean;
};

type TVoiceSessionCommandOutcome = 'succeeded' | 'failed' | 'expired' | 'cancelled' | 'superseded' | 'detached';

type TVoiceSessionCommandPhase =
	| 'rebuilding'
	| 'reconnecting'
	| 'waiting_online'
	| 'waiting_auth'
	| 'restoring'
	| 'retry_delay'
	| 'restore_watch'
	| 'connected_finalization'
	| 'failed_finalization';

type TVoiceSessionCommandObservationContext = {
	commandType: TVoiceSessionCommand['type'];
	commandId: number;
	generation: number;
	phase: TVoiceSessionCommandPhase;
	attempt?: number;
};

type TVoiceSessionCommandObservation = {
	run: <T>(effect: () => T) => T;
	finish: (result: { outcome: TVoiceSessionCommandOutcome; durationMs: number; error?: unknown }) => void;
};

type TVoiceSessionCommandObserver = {
	start: (context: TVoiceSessionCommandObservationContext) => TVoiceSessionCommandObservation;
};

type TVoiceSessionExecutorPorts = {
	// Injected environment: the executor never touches Date.now, Math.random,
	// setTimeout, navigator, or window, so tests control time, jitter, and
	// connectivity deterministically. delay must reject or resolve promptly when
	// its signal aborts. random/delay/isOnline back reconnect waits, and delay
	// also owns deterministic rebuild backoff and bounded cancellation drains.
	now: () => number;
	random: () => number;
	delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	isOnline: () => boolean;

	captureRecoverySnapshot: () => TWatchedRemoteStreamsSnapshot;
	rebuildTransports: (command: TRebuildTransportsCommand, context: TVoiceSessionRebuildContext) => Promise<void>;
	restoreVoiceSession: (
		command: TRestoreVoiceSessionCommand,
		context: TVoiceSessionRestoreContext,
	) => Promise<{ serverSessionEstablished: boolean }>;
	restoreWatchIntent: (snapshot: TWatchedRemoteStreamsSnapshot) => void;
	recoverDesktopAppAudio: () => Promise<void>;
	leaveVoiceSession: (channelId?: number) => Promise<void>;
	clearFailedSession: (command: TClearFailedSessionCommand) => Promise<void>;
	reportCommandError: (command: TVoiceSessionCommand, error: unknown) => void;
	reportRebuildDetached: (command: TRebuildTransportsCommand) => void;
	reportRebuildTerminalFailure: (command: TRebuildTransportsCommand, error: unknown) => void;
	reportRestoreDetached: (command: TRestoreVoiceSessionCommand) => void;
	commandObserver?: TVoiceSessionCommandObserver;
};

type TVoiceSessionCommandExecutor = {
	execute: (commands: TVoiceSessionCommand[]) => void;
	dispose: () => void;
};

// Recovery-step commands are the machine's single active step per recovery
// phase: their validity is phase.activeCommandId + generation, checked through
// the store. Final commands are emitted while LEAVING a recovery phase, so
// machine currency is always false for them — their validity is owned by the
// store's buffered-command flush filter (and per-handler generation checks
// from C2), never by stale-rejection here.
const isRecoveryStepCommand = (command: TVoiceSessionCommand): boolean => {
	switch (command.type) {
		case 'CaptureRecoverySnapshot':
		case 'RebuildTransports':
		case 'WaitOnline':
		case 'WaitAuth':
		case 'RestoreVoiceSession':
		case 'RetryDelay':
		case 'RestoreWatchIntent':
			return true;
		case 'RecoverDesktopAppAudio':
		case 'LeaveVoiceSession':
		case 'ClearFailedSession':
			return false;
	}
};

const isFinalCommand = (
	command: TVoiceSessionCommand,
): command is Extract<
	TVoiceSessionCommand,
	{ type: 'RecoverDesktopAppAudio' | 'LeaveVoiceSession' | 'ClearFailedSession' }
> => !isRecoveryStepCommand(command);

type TActiveVoiceSessionOperation = {
	command: TVoiceSessionCommand;
	controller: AbortController;
};

type TVoiceSessionCommandLifecycle = {
	command: TVoiceSessionCommand;
	startedAt: number;
	observation: TVoiceSessionCommandObservation;
	firstCause?: Extract<TVoiceSessionCommandOutcome, 'expired' | 'cancelled' | 'superseded'>;
	finished: boolean;
};

type TActiveRestoreOperation = {
	command: TRestoreVoiceSessionCommand;
	controller: AbortController;
	serverSessionEstablished: boolean;
	unsettledOperation?: Promise<unknown>;
};

type TActiveRebuildOperation = {
	command: TRebuildTransportsCommand;
	controller: AbortController;
	unsettledOperation?: Promise<unknown>;
};

const VOICE_RECONNECT_WAIT_POLL_MS = 250;
const VOICE_RECONNECT_TIMEOUT_MS = 12_000;
const VOICE_RECONNECT_CANCELLED_DRAIN_MS = 2_000;
const VOICE_REBUILD_BACKOFF_MS = [1_000, 2_000] as const;

const noOpCommandObservation: TVoiceSessionCommandObservation = {
	run: <T>(effect: () => T): T => effect(),
	finish: () => {},
};

const getCommandObservationContext = (command: TVoiceSessionCommand): TVoiceSessionCommandObservationContext => {
	const base = {
		commandType: command.type,
		commandId: command.commandId,
		generation: command.generation,
	};

	switch (command.type) {
		case 'CaptureRecoverySnapshot':
			return { ...base, phase: command.recovery };
		case 'RebuildTransports':
			return { ...base, phase: 'rebuilding', attempt: command.attempt + 1 };
		case 'WaitOnline':
			return { ...base, phase: 'waiting_online' };
		case 'WaitAuth':
			return { ...base, phase: 'waiting_auth' };
		case 'RestoreVoiceSession':
			return { ...base, phase: 'restoring', attempt: command.attempt + 1 };
		case 'RetryDelay':
			return { ...base, phase: 'retry_delay', attempt: command.attempt + 1 };
		case 'RestoreWatchIntent':
			return { ...base, phase: 'restore_watch' };
		case 'RecoverDesktopAppAudio':
			return { ...base, phase: 'connected_finalization' };
		case 'LeaveVoiceSession':
		case 'ClearFailedSession':
			return { ...base, phase: 'failed_finalization' };
	}
};

const createVoiceSessionCommandExecutor = (ports: TVoiceSessionExecutorPorts): TVoiceSessionCommandExecutor => {
	// Keyed by commandId, which the machine mints monotonically.
	const activeOperations = new Map<number, TActiveVoiceSessionOperation>();
	let activeRebuildOperation: TActiveRebuildOperation | undefined;
	let queuedRebuildCommand: TRebuildTransportsCommand | undefined;
	let activeRestoreOperation: TActiveRestoreOperation | undefined;
	let queuedRestoreCommand: TRestoreVoiceSessionCommand | undefined;
	let disposed = false;
	const lifecycles = new Map<number, TVoiceSessionCommandLifecycle>();

	const startLifecycle = (command: TVoiceSessionCommand): TVoiceSessionCommandLifecycle => {
		let observation = noOpCommandObservation;

		try {
			observation = ports.commandObserver?.start(getCommandObservationContext(command)) ?? noOpCommandObservation;
		} catch {
			// Telemetry is never a command correctness dependency.
		}

		const lifecycle: TVoiceSessionCommandLifecycle = {
			command,
			startedAt: ports.now(),
			observation,
			finished: false,
		};
		lifecycles.set(command.commandId, lifecycle);
		return lifecycle;
	};

	const recordFirstCause = (
		command: TVoiceSessionCommand,
		cause: NonNullable<TVoiceSessionCommandLifecycle['firstCause']>,
	): void => {
		const lifecycle = lifecycles.get(command.commandId);
		if (lifecycle && lifecycle.firstCause === undefined) {
			lifecycle.firstCause = cause;
		}
	};

	const finishLifecycle = (
		command: TVoiceSessionCommand,
		outcome: TVoiceSessionCommandOutcome,
		error?: unknown,
	): void => {
		const lifecycle = lifecycles.get(command.commandId);
		if (!lifecycle || lifecycle.finished) {
			return;
		}

		lifecycle.finished = true;
		lifecycles.delete(command.commandId);
		try {
			lifecycle.observation.finish({
				outcome,
				durationMs: Math.max(0, ports.now() - lifecycle.startedAt),
				error,
			});
		} catch {
			// Telemetry is never a command correctness dependency.
		}
	};

	const runObserved = <T>(command: TVoiceSessionCommand, effect: () => T): T => {
		const lifecycle = lifecycles.get(command.commandId);
		if (!lifecycle) {
			return effect();
		}

		let effectThrew = false;
		let effectStarted = false;
		let effectError: unknown;
		let readEffectResult = (): T => {
			throw new Error('Voice session observed effect did not return');
		};
		try {
			return lifecycle.observation.run(() => {
				effectStarted = true;
				try {
					const result = effect();
					readEffectResult = () => result;
					return result;
				} catch (error) {
					effectThrew = true;
					effectError = error;
					throw error;
				}
			});
		} catch (_error) {
			if (effectThrew) {
				throw effectError;
			}
			if (effectStarted) {
				return readEffectResult();
			}

			// If only the observer failed before invoking the effect, execute it
			// directly.
			return effect();
		}
	};

	const reportSafely = (report: () => void): void => {
		try {
			report();
		} catch {
			// Error reporting is telemetry, not command policy.
		}
	};

	const abortSupersededOperations = (): void => {
		for (const [commandId, operation] of activeOperations) {
			if (isRecoveryStepCommand(operation.command) && !isVoiceSessionCommandCurrent(operation.command)) {
				activeOperations.delete(commandId);
				recordFirstCause(operation.command, 'superseded');
				operation.controller.abort();
			}
		}

		if (activeRestoreOperation !== undefined && !isVoiceSessionCommandCurrent(activeRestoreOperation.command)) {
			recordFirstCause(activeRestoreOperation.command, 'superseded');
			activeRestoreOperation.controller.abort();
		}

		if (activeRebuildOperation !== undefined && !isVoiceSessionCommandCurrent(activeRebuildOperation.command)) {
			recordFirstCause(activeRebuildOperation.command, 'superseded');
			activeRebuildOperation.controller.abort();
		}

		if (queuedRestoreCommand !== undefined && !isVoiceSessionCommandCurrent(queuedRestoreCommand)) {
			recordFirstCause(queuedRestoreCommand, 'superseded');
			finishLifecycle(queuedRestoreCommand, 'superseded');
			queuedRestoreCommand = undefined;
		}

		if (queuedRebuildCommand !== undefined && !isVoiceSessionCommandCurrent(queuedRebuildCommand)) {
			recordFirstCause(queuedRebuildCommand, 'superseded');
			finishLifecycle(queuedRebuildCommand, 'superseded');
			queuedRebuildCommand = undefined;
		}
	};

	// Store listeners run before command delivery, so a superseding command's
	// dispatch aborts the operation it replaced before the new command's effect
	// starts — the executor never runs two effects for one recovery step.
	const unsubscribeFromStore = subscribeVoiceSessionState(() => {
		abortSupersededOperations();
	});

	const getLiveReconnectDeadline = (command: { generation: number; expiresAt: number }): number =>
		selectVoiceSessionState((state) => {
			const { phase } = state;

			return phase.phase === 'reconnecting' && phase.generation === command.generation
				? phase.pending.expiresAt
				: command.expiresAt;
		});

	const waitForDelay = async (milliseconds: number, signal: AbortSignal): Promise<'elapsed' | 'cancelled'> => {
		try {
			await ports.delay(milliseconds, signal);
			return 'elapsed';
		} catch (error) {
			if (signal.aborted) {
				return 'cancelled';
			}

			throw error;
		}
	};

	const waitForOnline = async (
		command: Extract<TVoiceSessionCommand, { type: 'WaitOnline' | 'RetryDelay' }>,
		context: TVoiceSessionCommandContext,
	): Promise<'online' | 'expired' | 'cancelled'> => {
		while (context.isCurrent()) {
			if (ports.isOnline()) {
				return 'online';
			}

			const remainingMs = getLiveReconnectDeadline(command) - ports.now();
			if (remainingMs < 0) {
				return 'expired';
			}

			// Preserve the legacy strict expiry boundary: equality still gets one
			// opportunity to observe connectivity before the window expires.
			const outcome = await waitForDelay(Math.min(remainingMs + 1, VOICE_RECONNECT_WAIT_POLL_MS), context.signal);
			if (outcome === 'cancelled') {
				return 'cancelled';
			}
		}

		return 'cancelled';
	};

	const waitForStateChangeOrDeadline = async (
		milliseconds: number,
		signal: AbortSignal,
		stateBeforeSubscribe: TVoiceSessionState,
	): Promise<'stateChanged' | 'deadline' | 'cancelled'> => {
		const controller = new AbortController();
		const abortChild = (): void => {
			controller.abort(signal.reason);
		};

		signal.addEventListener('abort', abortChild, { once: true });
		if (signal.aborted) {
			abortChild();
		}

		let unsubscribe = (): void => {};
		const stateChanged = new Promise<'stateChanged' | 'cancelled'>((resolve) => {
			unsubscribe = subscribeVoiceSessionState(() => {
				resolve('stateChanged');
			});
			// Guard a state update that lands after the caller's initial read but
			// before subscription. Store state is immutable, so reference identity is
			// a sufficient version check.
			if (selectVoiceSessionState((state) => state) !== stateBeforeSubscribe) {
				resolve('stateChanged');
			}
			controller.signal.addEventListener(
				'abort',
				() => {
					resolve('cancelled');
				},
				{ once: true },
			);
		});
		const deadline = waitForDelay(milliseconds, controller.signal).then((outcome) =>
			outcome === 'elapsed' ? ('deadline' as const) : ('cancelled' as const),
		);

		try {
			return await Promise.race([stateChanged, deadline]);
		} finally {
			unsubscribe();
			controller.abort();
			signal.removeEventListener('abort', abortChild);
		}
	};

	const waitForAuthenticated = async (
		command: Extract<TVoiceSessionCommand, { type: 'WaitAuth' }>,
		context: TVoiceSessionCommandContext,
	): Promise<'authenticated' | 'expired' | 'cleared' | 'cancelled'> => {
		while (context.isCurrent()) {
			const stateBeforeSubscribe = selectVoiceSessionState((state) => state);
			const reconnectingSince = selectReconnectingSince(stateBeforeSubscribe);
			if (reconnectingSince === undefined) {
				return 'cleared';
			}

			const authenticated = selectReconnectAuthenticated(stateBeforeSubscribe);
			if (authenticated) {
				// The legacy fast path accepted an already-authenticated socket before
				// consulting expiry; keep that behavior during this mechanical move.
				return 'authenticated';
			}

			const remainingMs = getLiveReconnectDeadline(command) - ports.now();
			if (remainingMs <= 0) {
				return 'expired';
			}

			const outcome = await waitForStateChangeOrDeadline(remainingMs, context.signal, stateBeforeSubscribe);
			if (outcome === 'cancelled') {
				return 'cancelled';
			}
		}

		return 'cancelled';
	};

	const waitForRetryDelay = async (
		command: Extract<TVoiceSessionCommand, { type: 'RetryDelay' }>,
		context: TVoiceSessionCommandContext,
	): Promise<'ready' | 'expired' | 'cancelled'> => {
		let remainingDelayMs = getVoiceReconnectRetryDelayMs(command.attempt, ports.random());

		while (remainingDelayMs > 0 && context.isCurrent()) {
			const remainingSessionMs = getLiveReconnectDeadline(command) - ports.now();
			if (remainingSessionMs < 0) {
				return 'expired';
			}

			if (!ports.isOnline()) {
				const onlineOutcome = await waitForOnline(command, context);
				if (onlineOutcome !== 'online') {
					return onlineOutcome;
				}

				continue;
			}

			const waitMs = Math.min(remainingDelayMs, VOICE_RECONNECT_WAIT_POLL_MS);
			const outcome = await waitForDelay(waitMs, context.signal);
			if (outcome === 'cancelled') {
				return 'cancelled';
			}

			remainingDelayMs -= waitMs;
		}

		if (!context.isCurrent()) {
			return 'cancelled';
		}

		return ports.now() > getLiveReconnectDeadline(command) ? 'expired' : 'ready';
	};

	const drainCancelledRestoreOperation = async (
		operation: Promise<unknown> | undefined,
	): Promise<'settled' | 'detached'> => {
		if (operation === undefined) {
			return 'settled';
		}

		const drainController = new AbortController();
		const settled = operation.then(
			() => 'settled' as const,
			() => 'settled' as const,
		);
		const drainElapsed = waitForDelay(VOICE_RECONNECT_CANCELLED_DRAIN_MS, drainController.signal).then((outcome) =>
			outcome === 'elapsed' ? ('detached' as const) : ('settled' as const),
		);

		try {
			return await Promise.race([settled, drainElapsed]);
		} finally {
			drainController.abort();
		}
	};

	const drainCancelledRebuildOperation = async (
		operation: Promise<unknown> | undefined,
	): Promise<'settled' | 'detached'> => {
		if (operation === undefined) {
			return 'settled';
		}

		const drainController = new AbortController();
		const settled = operation.then(
			() => 'settled' as const,
			() => 'settled' as const,
		);
		const drainElapsed = waitForDelay(VOICE_RECONNECT_CANCELLED_DRAIN_MS, drainController.signal).then((outcome) =>
			outcome === 'elapsed' ? ('detached' as const) : ('settled' as const),
		);

		try {
			return await Promise.race([settled, drainElapsed]);
		} finally {
			drainController.abort();
		}
	};

	const runRebuildCommand = async (active: TActiveRebuildOperation): Promise<void> => {
		const { command, controller } = active;
		let terminalOutcome: TVoiceSessionCommandOutcome | undefined;
		let terminalError: unknown;
		const context: TVoiceSessionRebuildContext = {
			signal: controller.signal,
			isCurrent: () => !controller.signal.aborted && isVoiceSessionCommandCurrent(command),
			restartIfNonceChanged: (currentNonce) => {
				if (!context.isCurrent()) {
					return true;
				}

				if (currentNonce === command.nonce) {
					return false;
				}

				dispatchVoiceSession({
					type: 'NonceChanged',
					commandId: command.commandId,
					generation: command.generation,
					nonce: currentNonce,
				});
				return true;
			},
		};

		try {
			if (command.attempt > 0) {
				const backoffMs = VOICE_REBUILD_BACKOFF_MS[command.attempt - 1] ?? VOICE_REBUILD_BACKOFF_MS.at(-1) ?? 1_000;
				const outcome = await waitForDelay(backoffMs, controller.signal);
				if (outcome === 'cancelled' || !context.isCurrent()) {
					terminalOutcome = lifecycles.get(command.commandId)?.firstCause ?? 'superseded';
					return;
				}
			}

			const operation = runObserved(command, () => ports.rebuildTransports(command, context));
			active.unsettledOperation = operation;
			const settled = operation.then(
				() => ({ outcome: 'succeeded' as const }),
				(error: unknown) => ({ outcome: 'failed' as const, error }),
			);
			let removeAbortListener = (): void => {};
			const cancelled = new Promise<{ outcome: 'cancelled' }>((resolve) => {
				const handleAbort = (): void => {
					resolve({ outcome: 'cancelled' });
				};

				removeAbortListener = () => {
					controller.signal.removeEventListener('abort', handleAbort);
				};
				controller.signal.addEventListener('abort', handleAbort, { once: true });
				if (controller.signal.aborted) {
					handleAbort();
				}
			});
			const result = await Promise.race([settled, cancelled]);
			removeAbortListener();

			if (result.outcome === 'failed' && context.isCurrent()) {
				terminalOutcome = 'failed';
				terminalError = result.error;
				dispatchVoiceSession({
					type: 'RebuildFailed',
					commandId: command.commandId,
					generation: command.generation,
					error: result.error,
				});

				// The reducer has already made the terminal-policy decision. Observing
				// its resulting phase here preserves diagnostics without classifying the
				// error or choosing retry versus teardown in the executor.
				const phase = selectVoiceSessionState((state) => state.phase);
				if (phase.phase === 'failed') {
					reportSafely(() => ports.reportRebuildTerminalFailure(command, result.error));
				}
			} else if (result.outcome === 'succeeded' && context.isCurrent()) {
				terminalOutcome = 'succeeded';
				dispatchVoiceSession({
					type: 'RebuildSucceeded',
					commandId: command.commandId,
					generation: command.generation,
				});
			} else {
				terminalOutcome = lifecycles.get(command.commandId)?.firstCause ?? 'superseded';
			}
		} catch (error) {
			terminalError = error;
			terminalOutcome =
				lifecycles.get(command.commandId)?.firstCause ??
				(isVoiceSessionCommandCurrent(command) ? 'failed' : 'superseded');
			throw error;
		} finally {
			const drainOutcome = await drainCancelledRebuildOperation(active.unsettledOperation);
			if (drainOutcome === 'detached') {
				reportSafely(() => ports.reportRebuildDetached(command));
				terminalOutcome = 'detached';
			}
			finishLifecycle(
				command,
				terminalOutcome ?? lifecycles.get(command.commandId)?.firstCause ?? 'cancelled',
				terminalError,
			);

			if (activeRebuildOperation === active) {
				activeRebuildOperation = undefined;
			}

			const queuedCommand = queuedRebuildCommand;
			queuedRebuildCommand = undefined;
			if (!disposed && queuedCommand !== undefined) {
				startRebuildCommand(queuedCommand);
			}
		}
	};

	const startRebuildCommand = (command: TRebuildTransportsCommand): void => {
		if (disposed || !isVoiceSessionCommandCurrent(command)) {
			finishLifecycle(command, disposed ? 'cancelled' : 'superseded');
			return;
		}

		if (activeRebuildOperation !== undefined) {
			if (queuedRebuildCommand !== undefined) {
				recordFirstCause(queuedRebuildCommand, 'superseded');
				finishLifecycle(queuedRebuildCommand, 'superseded');
			}
			recordFirstCause(activeRebuildOperation.command, 'superseded');
			activeRebuildOperation.controller.abort();
			queuedRebuildCommand = command;
			return;
		}

		const active: TActiveRebuildOperation = {
			command,
			controller: new AbortController(),
		};

		activeRebuildOperation = active;
		void runRebuildCommand(active).catch((error: unknown) => {
			reportSafely(() => ports.reportCommandError(command, error));
		});
	};

	const withRestoreTimeout = async <T>(active: TActiveRestoreOperation, operation: Promise<T>): Promise<T> => {
		active.unsettledOperation = operation;
		const timeoutController = new AbortController();
		let removeAbortListener = (): void => {};
		const cancelled = new Promise<never>((_, reject) => {
			const handleAbort = (): void => {
				reject(active.controller.signal.reason);
			};

			removeAbortListener = () => {
				active.controller.signal.removeEventListener('abort', handleAbort);
			};
			active.controller.signal.addEventListener('abort', handleAbort, { once: true });
			if (active.controller.signal.aborted) {
				handleAbort();
			}
		});
		const timeout = waitForDelay(VOICE_RECONNECT_TIMEOUT_MS, timeoutController.signal).then((outcome) => {
			if (outcome === 'cancelled') {
				return new Promise<never>(() => {});
			}

			throw new VoiceReconnectTimeoutError();
		});

		try {
			return await Promise.race([operation, timeout, cancelled]);
		} catch (error) {
			if (error instanceof VoiceReconnectTimeoutError) {
				active.controller.abort(error);
			}

			throw error;
		} finally {
			timeoutController.abort();
			removeAbortListener();
			void operation.then(
				() => {
					if (active.unsettledOperation === operation) {
						active.unsettledOperation = undefined;
					}
				},
				() => {
					if (active.unsettledOperation === operation) {
						active.unsettledOperation = undefined;
					}
				},
			);
		}
	};

	const runRestoreCommand = async (active: TActiveRestoreOperation): Promise<void> => {
		const { command, controller } = active;
		let terminalOutcome: TVoiceSessionCommandOutcome | undefined;
		let terminalError: unknown;
		const context: TVoiceSessionRestoreContext = {
			signal: controller.signal,
			isCurrent: () => !controller.signal.aborted && isVoiceSessionCommandCurrent(command),
			withTimeout: <T>(operation: Promise<T>): Promise<T> => withRestoreTimeout(active, operation),
			markServerSessionEstablished: () => {
				active.serverSessionEstablished = true;
			},
		};

		try {
			const result = await runObserved(command, () => ports.restoreVoiceSession(command, context));
			active.serverSessionEstablished = active.serverSessionEstablished || result.serverSessionEstablished;

			if (context.isCurrent()) {
				terminalOutcome = 'succeeded';
				dispatchVoiceSession({
					type: 'RestoreSucceeded',
					commandId: command.commandId,
					generation: command.generation,
					serverSessionEstablished: active.serverSessionEstablished,
				});
			} else {
				terminalOutcome = lifecycles.get(command.commandId)?.firstCause ?? 'superseded';
			}
		} catch (error) {
			terminalError = error;
			if (error instanceof VoiceReconnectTimeoutError) {
				recordFirstCause(command, 'expired');
			}
			terminalOutcome =
				lifecycles.get(command.commandId)?.firstCause ??
				(isVoiceSessionCommandCurrent(command) ? 'failed' : 'superseded');
			if (!disposed && isVoiceSessionCommandCurrent(command)) {
				dispatchVoiceSession({
					type: 'RestoreFailed',
					commandId: command.commandId,
					generation: command.generation,
					error,
					// The server may have committed a mutation whose response lost the
					// race with the client timeout. Retain known ownership after a
					// response, and conservatively assume it for any restore timeout.
					serverSessionEstablished: active.serverSessionEstablished || error instanceof VoiceReconnectTimeoutError,
				});
			}
		} finally {
			const drainOutcome = await drainCancelledRestoreOperation(active.unsettledOperation);
			if (drainOutcome === 'detached') {
				reportSafely(() => ports.reportRestoreDetached(command));
				terminalOutcome = 'detached';
			}
			finishLifecycle(
				command,
				terminalOutcome ?? lifecycles.get(command.commandId)?.firstCause ?? 'cancelled',
				terminalError,
			);

			if (activeRestoreOperation === active) {
				activeRestoreOperation = undefined;
			}

			const queuedCommand = queuedRestoreCommand;
			queuedRestoreCommand = undefined;
			if (!disposed && queuedCommand !== undefined) {
				startRestoreCommand(queuedCommand);
			}
		}
	};

	const startRestoreCommand = (command: TRestoreVoiceSessionCommand): void => {
		if (disposed || !isVoiceSessionCommandCurrent(command)) {
			finishLifecycle(command, disposed ? 'cancelled' : 'superseded');
			return;
		}

		if (activeRestoreOperation !== undefined) {
			if (queuedRestoreCommand !== undefined) {
				recordFirstCause(queuedRestoreCommand, 'superseded');
				finishLifecycle(queuedRestoreCommand, 'superseded');
			}
			recordFirstCause(activeRestoreOperation.command, 'superseded');
			activeRestoreOperation.controller.abort();
			queuedRestoreCommand = command;
			return;
		}

		const active: TActiveRestoreOperation = {
			command,
			controller: new AbortController(),
			serverSessionEstablished: false,
		};

		activeRestoreOperation = active;
		void runRestoreCommand(active).catch((error: unknown) => {
			reportSafely(() => ports.reportCommandError(command, error));
		});
	};

	// Result events are dispatched only while the command is still current;
	// a late settlement from an aborted operation is dropped here (the reducer
	// would also ignore it, but the executor must not depend on that).
	const runCommandEffect = async (
		command: TVoiceSessionCommand,
		context: TVoiceSessionCommandContext,
	): Promise<TVoiceSessionCommandOutcome> => {
		switch (command.type) {
			case 'CaptureRecoverySnapshot': {
				const snapshot = ports.captureRecoverySnapshot();

				if (context.isCurrent()) {
					dispatchVoiceSession({
						type: 'RecoveryStarted',
						commandId: command.commandId,
						generation: command.generation,
						snapshot,
					});
					return 'succeeded';
				}

				return lifecycles.get(command.commandId)?.firstCause ?? 'superseded';
			}
			case 'RebuildTransports': {
				return 'cancelled';
			}
			case 'RestoreVoiceSession':
				return 'cancelled';
			case 'WaitOnline': {
				const outcome = await waitForOnline(command, context);

				if (outcome !== 'cancelled' && context.isCurrent()) {
					dispatchVoiceSession({
						type: outcome === 'online' ? 'OnlineReady' : 'OnlineExpired',
						commandId: command.commandId,
						generation: command.generation,
					});
				}

				return outcome === 'expired'
					? 'expired'
					: outcome === 'cancelled'
						? (lifecycles.get(command.commandId)?.firstCause ?? 'superseded')
						: 'succeeded';
			}
			case 'WaitAuth': {
				const outcome = await waitForAuthenticated(command, context);

				if (outcome !== 'cancelled' && context.isCurrent()) {
					dispatchVoiceSession({
						type: outcome === 'authenticated' ? 'AuthReady' : outcome === 'cleared' ? 'AuthCleared' : 'AuthExpired',
						commandId: command.commandId,
						generation: command.generation,
					});
				}

				return outcome === 'expired'
					? 'expired'
					: outcome === 'cancelled'
						? (lifecycles.get(command.commandId)?.firstCause ?? 'superseded')
						: 'succeeded';
			}
			case 'RetryDelay': {
				const outcome = await waitForRetryDelay(command, context);

				if (outcome !== 'cancelled' && context.isCurrent()) {
					dispatchVoiceSession({
						type: outcome === 'ready' ? 'RetryDelayElapsed' : 'RetryDelayExpired',
						commandId: command.commandId,
						generation: command.generation,
					});
				}

				return outcome === 'expired'
					? 'expired'
					: outcome === 'cancelled'
						? (lifecycles.get(command.commandId)?.firstCause ?? 'superseded')
						: 'succeeded';
			}
			case 'RestoreWatchIntent': {
				ports.restoreWatchIntent(command.snapshot);

				if (context.isCurrent()) {
					dispatchVoiceSession({
						type: 'WatchIntentRehydrated',
						commandId: command.commandId,
						generation: command.generation,
						now: ports.now(),
					});
					return 'succeeded';
				}

				return lifecycles.get(command.commandId)?.firstCause ?? 'superseded';
			}
			case 'RecoverDesktopAppAudio':
				await ports.recoverDesktopAppAudio();
				return 'succeeded';
			case 'LeaveVoiceSession':
				await ports.leaveVoiceSession(command.channelId);
				return 'succeeded';
			case 'ClearFailedSession':
				await ports.clearFailedSession(command);
				return 'succeeded';
		}
	};

	const startCommand = (command: TVoiceSessionCommand): void => {
		// Stale at delivery: the machine already moved past this recovery step, so
		// its effect must never start.
		if (isRecoveryStepCommand(command) && !isVoiceSessionCommandCurrent(command)) {
			return;
		}
		if (isFinalCommand(command) && !isFinalVoiceSessionCommandCurrent(command)) {
			return;
		}

		startLifecycle(command);

		// Normally the store-listener sweep already ran inside the superseding
		// dispatch; this covers execute() being invoked outside a dispatch.
		abortSupersededOperations();
		if (command.type === 'RebuildTransports') {
			startRebuildCommand(command);
			return;
		}
		if (command.type === 'RestoreVoiceSession') {
			startRestoreCommand(command);
			return;
		}

		const controller = new AbortController();
		const operation: TActiveVoiceSessionOperation = { command, controller };

		activeOperations.set(command.commandId, operation);

		const isCurrent = isRecoveryStepCommand(command)
			? (): boolean => !controller.signal.aborted && isVoiceSessionCommandCurrent(command)
			: (): boolean => !controller.signal.aborted;

		void runObserved(command, () => runCommandEffect(command, { signal: controller.signal, isCurrent }))
			.then((outcome) => {
				finishLifecycle(command, outcome);
			})
			.catch((error: unknown) => {
				// Port rejections without a machine-defined failure event (final
				// commands, snapshot capture) must not strand executor bookkeeping.
				reportSafely(() => ports.reportCommandError(command, error));
				finishLifecycle(
					command,
					lifecycles.get(command.commandId)?.firstCause ??
						(isRecoveryStepCommand(command) && !isVoiceSessionCommandCurrent(command) ? 'superseded' : 'failed'),
					error,
				);
			})
			.finally(() => {
				if (activeOperations.get(command.commandId) === operation) {
					activeOperations.delete(command.commandId);
				}
			});
	};

	return {
		execute: (commands) => {
			if (disposed) {
				return;
			}

			for (const command of commands) {
				startCommand(command);
			}
		},
		dispose: () => {
			if (disposed) {
				return;
			}

			disposed = true;
			unsubscribeFromStore();
			if (queuedRebuildCommand !== undefined) {
				recordFirstCause(queuedRebuildCommand, 'cancelled');
				finishLifecycle(queuedRebuildCommand, 'cancelled');
				queuedRebuildCommand = undefined;
			}
			if (queuedRestoreCommand !== undefined) {
				recordFirstCause(queuedRestoreCommand, 'cancelled');
				finishLifecycle(queuedRestoreCommand, 'cancelled');
				queuedRestoreCommand = undefined;
			}
			if (activeRebuildOperation !== undefined) {
				recordFirstCause(activeRebuildOperation.command, 'cancelled');
			}
			if (activeRestoreOperation !== undefined) {
				recordFirstCause(activeRestoreOperation.command, 'cancelled');
			}
			activeRebuildOperation?.controller.abort();
			activeRestoreOperation?.controller.abort();

			for (const operation of activeOperations.values()) {
				recordFirstCause(operation.command, 'cancelled');
				operation.controller.abort();
				finishLifecycle(operation.command, 'cancelled');
			}

			activeOperations.clear();
		},
	};
};

export type {
	TVoiceSessionCommandContext,
	TVoiceSessionCommandExecutor,
	TVoiceSessionCommandObservation,
	TVoiceSessionCommandObservationContext,
	TVoiceSessionCommandObserver,
	TVoiceSessionCommandOutcome,
	TVoiceSessionCommandPhase,
	TVoiceSessionExecutorPorts,
	TVoiceSessionRebuildContext,
	TVoiceSessionRestoreContext,
};
export { createVoiceSessionCommandExecutor };
