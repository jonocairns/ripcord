import { useLayoutEffect } from 'react';
import {
	mountDesktopAppAudioRecoveryController,
	type TDesktopAppAudioRecoveryController,
} from '../desktop-app-audio-recovery-controller';

const useDesktopAppAudioRecoveryLifecycle = (controller: TDesktopAppAudioRecoveryController): void => {
	// Recovery commands run from passive executor effects. Layout lifecycle owns
	// the earlier setup and cleanup boundary, including React Strict Mode replay.
	useLayoutEffect(() => mountDesktopAppAudioRecoveryController(controller), [controller]);
};

export { useDesktopAppAudioRecoveryLifecycle };
