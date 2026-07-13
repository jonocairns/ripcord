import {
	createInitialVoiceSessionState,
	isCurrentVoiceSessionCommand,
	reduceVoiceSession,
	shouldFlushBufferedVoiceSessionCommand,
	type TVoiceSessionCommand,
	type TVoiceSessionEvent,
	type TVoiceSessionState,
} from './voice-session-machine';

type TVoiceSessionListener = (state: TVoiceSessionState, commands: TVoiceSessionCommand[]) => void;
type TVoiceSessionStateListener = (state: TVoiceSessionState) => void;
type TVoiceSessionCommandRunner = (commands: TVoiceSessionCommand[]) => void;
type TVoiceSessionSelector<T> = (state: TVoiceSessionState) => T;

let voiceSessionState = createInitialVoiceSessionState();
const listeners = new Set<TVoiceSessionListener>();
// State-only observation (useVoiceSessionSelector, executor supersession
// sweeps): the callback never sees commands, so observers cannot grow into
// accidental command runners. Long-lived like `listeners` — they survive
// resetVoiceSessionState.
const stateListeners = new Set<TVoiceSessionStateListener>();

// Commands are side effects that MUST eventually execute — RecoverDesktopAppAudio
// after a rebuild, LeaveVoiceSession/ClearFailedSession on terminal failure.
// Listeners only observe. A result event can land in the gap between the old
// provider unsubscribing and the new one mounting (its async runner outlives the
// unmount), and some results leave the phases that Resumed replays (connected /
// failed) — so commands dispatched with no runner registered are buffered and
// flushed to the next runner instead of being dropped.
let commandRunner: TVoiceSessionCommandRunner | undefined;
let bufferedCommands: TVoiceSessionCommand[] = [];

const dispatchVoiceSession = (event: TVoiceSessionEvent): TVoiceSessionCommand[] => {
	const result = reduceVoiceSession(voiceSessionState, event);

	voiceSessionState = result.state;

	// All listeners run before command delivery so a runner can never observe
	// pre-dispatch state. State-only listeners are the direct machine
	// observation primitive, while full listeners observe both state and the
	// commands produced by the transition.
	stateListeners.forEach((listener) => {
		listener(voiceSessionState);
	});
	listeners.forEach((listener) => {
		listener(voiceSessionState, result.commands);
	});

	if (result.commands.length > 0) {
		if (commandRunner !== undefined) {
			commandRunner(result.commands);
		} else {
			bufferedCommands.push(...result.commands);
		}
	}

	return result.commands;
};

const registerVoiceSessionCommandRunner = (runner: TVoiceSessionCommandRunner): (() => void) => {
	commandRunner = runner;

	if (bufferedCommands.length > 0) {
		// Re-validate against the machine state at flush time: the lifecycle may
		// have moved on (RecoveryCleared, a new join) since a command was
		// buffered, and recovery-step commands are replayed by Resumed instead.
		const commands = bufferedCommands.filter((command) =>
			shouldFlushBufferedVoiceSessionCommand(voiceSessionState, command),
		);

		bufferedCommands = [];

		if (commands.length > 0) {
			runner(commands);
		}
	}

	return () => {
		if (commandRunner === runner) {
			commandRunner = undefined;
		}
	};
};

const getVoiceSessionState = (): TVoiceSessionState => voiceSessionState;

const selectVoiceSessionState = <T>(selector: TVoiceSessionSelector<T>): T => selector(voiceSessionState);

// Live command currency: true only while the machine still stands behind this
// exact recovery-step command (phase generation + activeCommandId). Final
// commands (RecoverDesktopAppAudio, LeaveVoiceSession, ClearFailedSession) are
// emitted while leaving a recovery phase, so this is always false for them.
const isVoiceSessionCommandCurrent = (command: { commandId: number; generation: number }): boolean =>
	isCurrentVoiceSessionCommand(voiceSessionState, command);

const isFinalVoiceSessionCommandCurrent = (command: TVoiceSessionCommand): boolean =>
	shouldFlushBufferedVoiceSessionCommand(voiceSessionState, command);

const subscribeVoiceSession = (listener: TVoiceSessionListener): (() => void) => {
	listeners.add(listener);

	return () => {
		listeners.delete(listener);
	};
};

const subscribeVoiceSessionState = (listener: TVoiceSessionStateListener): (() => void) => {
	stateListeners.add(listener);

	return () => {
		stateListeners.delete(listener);
	};
};

const resetVoiceSessionState = (): void => {
	// Keep the identity counters monotonic across reset: listeners (and their
	// pending executor operations) survive reset, so a post-reset session must
	// never mint a generation/commandId pair that a still-pending pre-reset
	// operation already holds — a late completion would read as current and
	// advance the new session.
	const { nextCommandId, nextGeneration } = voiceSessionState;

	voiceSessionState = { ...createInitialVoiceSessionState(), nextCommandId, nextGeneration };
	bufferedCommands = [];

	stateListeners.forEach((listener) => {
		listener(voiceSessionState);
	});
};

export type { TVoiceSessionCommandRunner, TVoiceSessionListener, TVoiceSessionSelector, TVoiceSessionStateListener };
export {
	dispatchVoiceSession,
	getVoiceSessionState,
	isFinalVoiceSessionCommandCurrent,
	isVoiceSessionCommandCurrent,
	registerVoiceSessionCommandRunner,
	resetVoiceSessionState,
	selectVoiceSessionState,
	subscribeVoiceSession,
	subscribeVoiceSessionState,
};
