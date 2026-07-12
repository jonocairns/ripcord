import { getVoiceReconnectRetryDelayMs } from './reconnect-policy';
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
// This module is NOT registered as the production command runner yet. The
// embedded VoiceProvider runner still owns command execution; slices C2–C6 of
// docs/voice/voice-session-execution-extraction-plan.md move commands here and
// cut the provider over.

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

type TVoiceSessionExecutorPorts = {
	// Injected environment: the executor never touches Date.now, Math.random,
	// setTimeout, navigator, or window, so tests control time, jitter, and
	// connectivity deterministically. delay must reject or resolve promptly when
	// its signal aborts. random/delay/isOnline back the wait commands once C3
	// moves them here.
	now: () => number;
	random: () => number;
	delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	isOnline: () => boolean;

	captureRecoverySnapshot: () => TWatchedRemoteStreamsSnapshot;
	rebuildTransports: (command: TRebuildTransportsCommand, context: TVoiceSessionCommandContext) => Promise<void>;
	restoreVoiceSession: (
		command: TRestoreVoiceSessionCommand,
		context: TVoiceSessionCommandContext,
	) => Promise<{ serverSessionEstablished: boolean }>;
	restoreWatchIntent: (snapshot: TWatchedRemoteStreamsSnapshot) => void;
	recoverDesktopAppAudio: () => Promise<void>;
	leaveVoiceSession: (channelId?: number) => Promise<void>;
	clearFailedSession: (command: TClearFailedSessionCommand) => Promise<void>;
	reportCommandError: (command: TVoiceSessionCommand, error: unknown) => void;
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

const VOICE_RECONNECT_WAIT_POLL_MS = 250;

const createVoiceSessionCommandExecutor = (ports: TVoiceSessionExecutorPorts): TVoiceSessionCommandExecutor => {
	// Keyed by commandId, which the machine mints monotonically.
	const activeOperations = new Map<number, TActiveVoiceSessionOperation>();
	let disposed = false;

	const abortSupersededOperations = (): void => {
		for (const [commandId, operation] of activeOperations) {
			if (isRecoveryStepCommand(operation.command) && !isVoiceSessionCommandCurrent(operation.command)) {
				activeOperations.delete(commandId);
				operation.controller.abort();
			}
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
			if (remainingMs <= 0) {
				return 'expired';
			}

			const outcome = await waitForDelay(Math.min(remainingMs, VOICE_RECONNECT_WAIT_POLL_MS), context.signal);
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
				return ports.now() >= getLiveReconnectDeadline(command) ? 'expired' : 'authenticated';
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
			if (remainingSessionMs <= 0) {
				return 'expired';
			}

			if (!ports.isOnline()) {
				const onlineOutcome = await waitForOnline(command, context);
				if (onlineOutcome !== 'online') {
					return onlineOutcome;
				}

				continue;
			}

			const waitMs = Math.min(remainingDelayMs, remainingSessionMs, VOICE_RECONNECT_WAIT_POLL_MS);
			const outcome = await waitForDelay(waitMs, context.signal);
			if (outcome === 'cancelled') {
				return 'cancelled';
			}

			remainingDelayMs -= waitMs;
		}

		if (!context.isCurrent()) {
			return 'cancelled';
		}

		return ports.now() >= getLiveReconnectDeadline(command) ? 'expired' : 'ready';
	};

	// Result events are dispatched only while the command is still current;
	// a late settlement from an aborted operation is dropped here (the reducer
	// would also ignore it, but the executor must not depend on that).
	const runCommandEffect = async (
		command: TVoiceSessionCommand,
		context: TVoiceSessionCommandContext,
	): Promise<void> => {
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
				}

				return;
			}
			case 'RebuildTransports': {
				try {
					await ports.rebuildTransports(command, context);
				} catch (error) {
					if (context.isCurrent()) {
						dispatchVoiceSession({
							type: 'RebuildFailed',
							commandId: command.commandId,
							generation: command.generation,
							error,
						});
					}

					return;
				}

				if (context.isCurrent()) {
					dispatchVoiceSession({
						type: 'RebuildSucceeded',
						commandId: command.commandId,
						generation: command.generation,
					});
				}

				return;
			}
			case 'RestoreVoiceSession': {
				// Errors stay raw: retry-versus-terminal classification belongs to the
				// reducer. C4 additionally moves single-flight, timeout, sticky
				// serverSessionEstablished, and bounded cancellation drain here.
				try {
					const result = await ports.restoreVoiceSession(command, context);

					if (context.isCurrent()) {
						dispatchVoiceSession({
							type: 'RestoreSucceeded',
							commandId: command.commandId,
							generation: command.generation,
							serverSessionEstablished: result.serverSessionEstablished,
						});
					}
				} catch (error) {
					if (context.isCurrent()) {
						dispatchVoiceSession({
							type: 'RestoreFailed',
							commandId: command.commandId,
							generation: command.generation,
							error,
						});
					}
				}

				return;
			}
			case 'WaitOnline': {
				const outcome = await waitForOnline(command, context);

				if (outcome !== 'cancelled' && context.isCurrent()) {
					dispatchVoiceSession({
						type: outcome === 'online' ? 'OnlineReady' : 'OnlineExpired',
						commandId: command.commandId,
						generation: command.generation,
					});
				}

				return;
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

				return;
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

				return;
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
				}

				return;
			}
			case 'RecoverDesktopAppAudio':
				await ports.recoverDesktopAppAudio();
				return;
			case 'LeaveVoiceSession':
				await ports.leaveVoiceSession(command.channelId);
				return;
			case 'ClearFailedSession':
				await ports.clearFailedSession(command);
				return;
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

		// Normally the store-listener sweep already ran inside the superseding
		// dispatch; this covers execute() being invoked outside a dispatch.
		abortSupersededOperations();

		const controller = new AbortController();
		const operation: TActiveVoiceSessionOperation = { command, controller };

		activeOperations.set(command.commandId, operation);

		const isCurrent = isRecoveryStepCommand(command)
			? (): boolean => !controller.signal.aborted && isVoiceSessionCommandCurrent(command)
			: (): boolean => !controller.signal.aborted;

		void runCommandEffect(command, { signal: controller.signal, isCurrent })
			.catch((error: unknown) => {
				// Port rejections without a machine-defined failure event (final
				// commands, snapshot capture) must not strand executor bookkeeping.
				ports.reportCommandError(command, error);
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

			for (const operation of activeOperations.values()) {
				operation.controller.abort();
			}

			activeOperations.clear();
		},
	};
};

export type { TVoiceSessionCommandContext, TVoiceSessionCommandExecutor, TVoiceSessionExecutorPorts };
export { createVoiceSessionCommandExecutor };
