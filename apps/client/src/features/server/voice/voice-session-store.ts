import {
	createInitialVoiceSessionState,
	reduceVoiceSession,
	shouldFlushBufferedVoiceSessionCommand,
	type TVoiceSessionCommand,
	type TVoiceSessionEvent,
	type TVoiceSessionState,
} from './voice-session-machine';

type TVoiceSessionListener = (state: TVoiceSessionState, commands: TVoiceSessionCommand[]) => void;
type TVoiceSessionCommandRunner = (commands: TVoiceSessionCommand[]) => void;
type TVoiceSessionSelector<T> = (state: TVoiceSessionState) => T;

let voiceSessionState = createInitialVoiceSessionState();
const listeners = new Set<TVoiceSessionListener>();

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

	// Listeners first: the reconnect-coordinator listener syncs the zustand
	// projection, and command runners read that projection — running commands
	// before it would hand them pre-dispatch state.
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

const subscribeVoiceSession = (listener: TVoiceSessionListener): (() => void) => {
	listeners.add(listener);

	return () => {
		listeners.delete(listener);
	};
};

const resetVoiceSessionState = (): void => {
	voiceSessionState = createInitialVoiceSessionState();
	bufferedCommands = [];
};

export type { TVoiceSessionCommandRunner, TVoiceSessionListener, TVoiceSessionSelector };
export {
	dispatchVoiceSession,
	getVoiceSessionState,
	registerVoiceSessionCommandRunner,
	resetVoiceSessionState,
	selectVoiceSessionState,
	subscribeVoiceSession,
};
