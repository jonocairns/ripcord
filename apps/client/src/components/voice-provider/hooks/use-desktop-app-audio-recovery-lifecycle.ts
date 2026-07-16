import { useLayoutEffect } from 'react';
import type { TDesktopAppAudioRecoveryLifecycle } from '../desktop-app-audio-recovery-controller';

const mountDesktopAppAudioRecoveryController = (controller: TDesktopAppAudioRecoveryLifecycle): (() => void) => {
	controller.activate();

	let mounted = true;

	return () => {
		if (!mounted) {
			return;
		}

		mounted = false;
		controller.deactivate();
	};
};

const useDesktopAppAudioRecoveryLifecycle = (controller: TDesktopAppAudioRecoveryLifecycle): void => {
	// Recovery commands run from passive executor effects. Layout lifecycle owns
	// the earlier setup and cleanup boundary, including React Strict Mode replay.
	useLayoutEffect(() => mountDesktopAppAudioRecoveryController(controller), [controller]);
};

export { mountDesktopAppAudioRecoveryController, useDesktopAppAudioRecoveryLifecycle };
