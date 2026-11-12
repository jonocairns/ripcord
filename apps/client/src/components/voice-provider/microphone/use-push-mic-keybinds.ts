import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useServerStore } from '@/features/server/slice';
import { setOwnPushHold } from '@/features/server/voice/actions';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import {
	createPushMicKeybindController,
	mountPushMicKeybindController,
	type TPushMicKeybindInputs,
} from './push-mic-keybind-controller';

const usePushMicKeybinds = (inputs: TPushMicKeybindInputs): void => {
	const inputsRef = useLatestRef(inputs);
	// Match the provider's current control callback even during effect cleanup;
	// channel, permission and settings retain their committed useLatestRef timing.
	const ensureMicStartedRef = useRef(inputs.ensureMicStarted);
	ensureMicStartedRef.current = inputs.ensureMicStarted;
	const controllerRef = useRef<ReturnType<typeof createPushMicKeybindController> | undefined>(undefined);
	if (!controllerRef.current) {
		controllerRef.current = createPushMicKeybindController({
			getInputs: () => ({ ...inputsRef.current, ensureMicStarted: ensureMicStartedRef.current }),
			// Read live mute/deafen state when events arrive before the next React commit.
			getHold: () => useServerStore.getState().ownPushHold,
			setHold: (hold) => {
				setOwnPushHold(hold);
				void ensureMicStartedRef.current();
			},
			getDesktopBridge,
			setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
			clearTimeout: (handle) => window.clearTimeout(handle),
			log: logVoice,
			warn: (message) => toast.warning(message),
		});
	}
	const controller = controllerRef.current;

	useEffect(
		() =>
			mountPushMicKeybindController(controller, {
				pushToTalkKeybind: inputs.pushToTalkKeybind,
				pushToMuteKeybind: inputs.pushToMuteKeybind,
			}),
		[controller, inputs.pushToTalkKeybind, inputs.pushToMuteKeybind],
	);

	useEffect(() => {
		controller.reconcileChannelPermission(inputs.currentVoiceChannelId, inputs.canSpeak);
	}, [controller, inputs.currentVoiceChannelId, inputs.canSpeak]);
};

export { usePushMicKeybinds };
