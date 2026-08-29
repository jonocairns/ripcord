type TPushKeybindKind = 'talk' | 'mute';

type TPushMicState = {
	isPushToTalkHeld: boolean;
	isPushToMuteHeld: boolean;
	micMutedBeforePush: boolean | undefined;
};

type TPushKeybindEvent = {
	kind: TPushKeybindKind;
	active: boolean;
};

type TPushMicResolution = {
	targetMicMuted: boolean | undefined;
	shouldClearMicMutedBeforePush: boolean;
};

const updatePushMicStateForKeyEvent = (
	state: TPushMicState,
	event: TPushKeybindEvent,
	currentMicMuted: boolean,
): TPushMicState => {
	const shouldCaptureBaseline =
		!state.isPushToTalkHeld && !state.isPushToMuteHeld && event.active && state.micMutedBeforePush === undefined;
	const micMutedBeforePush = shouldCaptureBaseline ? currentMicMuted : state.micMutedBeforePush;

	if (event.kind === 'talk') {
		return {
			...state,
			isPushToTalkHeld: event.active,
			micMutedBeforePush,
		};
	}

	return {
		...state,
		isPushToMuteHeld: event.active,
		micMutedBeforePush,
	};
};

const clearHeldPushMicState = (state: TPushMicState): TPushMicState => {
	return {
		...state,
		isPushToTalkHeld: false,
		isPushToMuteHeld: false,
	};
};

const resolveHeldPushMicTarget = (state: TPushMicState): boolean | undefined => {
	if (state.isPushToMuteHeld) {
		return true;
	}

	if (state.isPushToTalkHeld) {
		return false;
	}

	return undefined;
};

const resolveMicMutedRollbackTarget = (state: TPushMicState, previousMicMuted: boolean): boolean => {
	// A failed mic sync must roll back to the live push intent, not the state
	// captured before the operation. A held key's target wins; otherwise a pending
	// restore baseline (e.g. after push-to-talk release, before it is cleared) wins.
	// Only when no push override is in play is the pre-operation state the right
	// fallback. Without this, a failed sync strands the mic open — while
	// push-to-mute is held, or after push-to-talk release restores to unmuted.
	const heldTarget = resolveHeldPushMicTarget(state);
	if (heldTarget !== undefined) {
		return heldTarget;
	}

	if (state.micMutedBeforePush !== undefined) {
		return state.micMutedBeforePush;
	}

	return previousMicMuted;
};

const resolveMicMutedFailureRollbackTarget = (
	failureKind: 'server-sync' | 'microphone-acquisition',
	previousMicMuted: boolean,
	pushAwareRollbackMicMuted: boolean,
): boolean => {
	// A server-sync failure should preserve current push intent. An acquisition
	// failure means that intent could not be fulfilled, so restore the known-safe
	// state from before the attempted unmute instead.
	return failureKind === 'microphone-acquisition' ? previousMicMuted : pushAwareRollbackMicMuted;
};

const resolvePushMicState = (state: TPushMicState, soundMuted: boolean): TPushMicResolution => {
	const heldTarget = resolveHeldPushMicTarget(state);

	if (soundMuted) {
		return {
			targetMicMuted: true,
			shouldClearMicMutedBeforePush: heldTarget === undefined && state.micMutedBeforePush !== undefined,
		};
	}

	if (heldTarget !== undefined) {
		return {
			targetMicMuted: heldTarget,
			shouldClearMicMutedBeforePush: false,
		};
	}

	if (state.micMutedBeforePush !== undefined) {
		return {
			targetMicMuted: state.micMutedBeforePush,
			shouldClearMicMutedBeforePush: true,
		};
	}

	return {
		targetMicMuted: undefined,
		shouldClearMicMutedBeforePush: false,
	};
};

export type { TPushMicState };
export {
	clearHeldPushMicState,
	resolveHeldPushMicTarget,
	resolveMicMutedFailureRollbackTarget,
	resolveMicMutedRollbackTarget,
	resolvePushMicState,
	updatePushMicStateForKeyEvent,
};
