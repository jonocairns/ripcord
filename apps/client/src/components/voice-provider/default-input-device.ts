// Browser adapter for "Default" microphone selection. Chromium represents the
// OS default input as a synthetic device entry; after mic permission is granted,
// its groupId tracks the physical input currently backing that default.
import { DEFAULT_MEDIA_DEVICE_ID } from '../devices-provider/media-device-selection';

type TDefaultInputChangeInput = {
	// groupId of the device our open capture is actually bound to.
	capturedGroupId: string | undefined;
	// groupId of the current system-default input entry, if resolvable.
	defaultGroupId: string | undefined;
};

type TDefaultInputMove = {
	capturedGroupId: string;
	defaultGroupId: string;
};

type TDefaultInputRecoveryDecision = {
	action: 'wait' | 'ignore-duplicate' | 'reacquire' | 'teardown-for-unmute';
	handledMove: TDefaultInputMove | undefined;
};

type TDefaultInputRecoveryInput = TDefaultInputChangeInput & {
	micMuted: boolean;
	handledMove: TDefaultInputMove | undefined;
};

const resolveDefaultInputGroupId = (inputs: { deviceId: string; groupId: string }[]): string | undefined => {
	const defaultEntry = inputs.find((input) => input.deviceId === DEFAULT_MEDIA_DEVICE_ID && input.groupId);
	return defaultEntry?.groupId;
};

// True only when we can confidently see that the system default moved to a
// different device than the one we're capturing. Missing/ambiguous data returns
// false so we never re-acquire (and blip the mic) on a guess.
const didDefaultInputDeviceChange = ({ capturedGroupId, defaultGroupId }: TDefaultInputChangeInput): boolean => {
	if (!defaultGroupId || !capturedGroupId) {
		return false;
	}

	return defaultGroupId !== capturedGroupId;
};

const resolveDefaultInputRecoveryDecision = ({
	capturedGroupId,
	defaultGroupId,
	micMuted,
	handledMove,
}: TDefaultInputRecoveryInput): TDefaultInputRecoveryDecision => {
	if (!capturedGroupId || !defaultGroupId) {
		return { action: 'wait', handledMove };
	}

	if (capturedGroupId === defaultGroupId) {
		return { action: 'wait', handledMove: undefined };
	}

	const detectedMove = { capturedGroupId, defaultGroupId };
	if (
		handledMove?.capturedGroupId === detectedMove.capturedGroupId &&
		handledMove.defaultGroupId === detectedMove.defaultGroupId
	) {
		return { action: 'ignore-duplicate', handledMove };
	}

	return {
		action: micMuted ? 'teardown-for-unmute' : 'reacquire',
		handledMove: detectedMove,
	};
};

export type { TDefaultInputChangeInput, TDefaultInputMove };
export { didDefaultInputDeviceChange, resolveDefaultInputGroupId, resolveDefaultInputRecoveryDecision };
