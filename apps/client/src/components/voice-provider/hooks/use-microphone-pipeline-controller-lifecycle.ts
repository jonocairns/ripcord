import { useLayoutEffect } from 'react';
import type { TMicrophonePipelineLifecycle } from '../microphone-pipeline-controller';

const mountMicrophonePipelineController = (controller: TMicrophonePipelineLifecycle): (() => void) => {
	controller.activate();

	let mounted = true;

	return () => {
		if (!mounted) {
			return;
		}

		mounted = false;
		void controller.deactivate();
	};
};

const useMicrophonePipelineControllerLifecycle = (controller: TMicrophonePipelineLifecycle): void => {
	// Layout setup activates before passive voice command/activity effects. Layout
	// cleanup also fences microphone work before those passive effects disconnect.
	useLayoutEffect(() => mountMicrophonePipelineController(controller), [controller]);
};

export { mountMicrophonePipelineController, useMicrophonePipelineControllerLifecycle };
