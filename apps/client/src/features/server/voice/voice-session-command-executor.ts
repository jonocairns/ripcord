import type { TVoiceSessionCommand, TWatchedRemoteStreamsSnapshot } from './voice-session-machine';
import { dispatchVoiceSession, isVoiceSessionCommandCurrent, subscribeVoiceSession } from './voice-session-store';

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

type TActiveVoiceSessionOperation = {
	command: TVoiceSessionCommand;
	controller: AbortController;
};

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
	const unsubscribeFromStore = subscribeVoiceSession(() => {
		abortSupersededOperations();
	});

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
			case 'WaitOnline':
			case 'WaitAuth':
			case 'RetryDelay':
				// C3 implements these from the delay/isOnline/random ports and direct
				// store subscriptions. The executor is not the production runner yet,
				// so nothing is stranded by leaving them unexecuted here.
				return;
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
			.catch(() => {
				// Port rejections without a machine-defined failure event (final
				// commands, snapshot capture) must not strand executor bookkeeping.
				// C2 adds error reporting when these handlers take production traffic.
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
