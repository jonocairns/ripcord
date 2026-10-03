import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import {
	createPushMicKeybindController,
	mountPushMicKeybindController,
	type TPushMicKeybindInputs,
} from '../push-mic-keybind-controller';

type TUsePushMicKeybindsParams = TPushMicKeybindInputs & {
	confirmedMicMuted: boolean | undefined;
};

const usePushMicKeybinds = (inputs: TUsePushMicKeybindsParams): void => {
	const inputsRef = useLatestRef(inputs);
	// Match the provider's current control callback even during effect cleanup;
	// voice state and settings retain their committed useLatestRef timing.
	const setMicMutedRef = useRef(inputs.setMicMuted);
	setMicMutedRef.current = inputs.setMicMuted;
	const controllerRef = useRef<ReturnType<typeof createPushMicKeybindController> | undefined>(undefined);
	if (!controllerRef.current) {
		controllerRef.current = createPushMicKeybindController({
			getInputs: () => ({ ...inputsRef.current, setMicMuted: setMicMutedRef.current }),
			getDesktopBridge,
			setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
			clearTimeout: (handle) => window.clearTimeout(handle),
			log: logVoice,
			warn: (message) => toast.warning(message),
		});
	}
	const controller = controllerRef.current;

	useEffect(() => {
		controller.reconcileConfirmedMicMuted(inputs.confirmedMicMuted);
	}, [controller, inputs.confirmedMicMuted]);

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
