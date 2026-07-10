import {
	createInitialVoiceSessionState,
	reduceVoiceSession,
	type TVoiceSessionCommand,
	type TVoiceSessionEvent,
	type TVoiceSessionState,
} from './voice-session-machine';

type TVoiceSessionListener = (state: TVoiceSessionState, commands: TVoiceSessionCommand[]) => void;
type TVoiceSessionSelector<T> = (state: TVoiceSessionState) => T;

let voiceSessionState = createInitialVoiceSessionState();
const listeners = new Set<TVoiceSessionListener>();

const dispatchVoiceSession = (event: TVoiceSessionEvent): TVoiceSessionCommand[] => {
	const result = reduceVoiceSession(voiceSessionState, event);

	voiceSessionState = result.state;

	listeners.forEach((listener) => {
		listener(voiceSessionState, result.commands);
	});

	return result.commands;
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
};

export type { TVoiceSessionListener, TVoiceSessionSelector };
export {
	dispatchVoiceSession,
	getVoiceSessionState,
	resetVoiceSessionState,
	selectVoiceSessionState,
	subscribeVoiceSession,
};
