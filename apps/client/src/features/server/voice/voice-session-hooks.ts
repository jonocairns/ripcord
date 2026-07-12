import { useSyncExternalStore } from 'react';
import type { TVoiceSessionState } from './voice-session-machine';
import { getVoiceSessionState, subscribeVoiceSessionState } from './voice-session-store';

// React binding for the voice session machine. Components read machine state
// directly through this hook instead of the zustand reconnect projection, so
// rendering has no dependency on projection synchronization order.
//
// Selectors must return stable references for unchanged state (the direct
// machine selectors in voice-session-machine.ts do): useSyncExternalStore
// re-renders whenever consecutive snapshots fail Object.is.

const subscribeToVoiceSessionState = (onStoreChange: () => void): (() => void) =>
	subscribeVoiceSessionState(onStoreChange);

const useVoiceSessionSelector = <T>(selector: (state: TVoiceSessionState) => T): T =>
	useSyncExternalStore(
		subscribeToVoiceSessionState,
		() => selector(getVoiceSessionState()),
		() => selector(getVoiceSessionState()),
	);

export { useVoiceSessionSelector };
