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
export { clearHeldPushMicState, resolveHeldPushMicTarget, resolvePushMicState, updatePushMicStateForKeyEvent };
