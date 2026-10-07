import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import {
	mountMediaSettingsIntegration,
	type TMediaSettingsDependencies,
	type TMediaSettingsInputs,
} from './media-settings-integration';

type TUseMediaSettingsInputs = TMediaSettingsInputs &
	Pick<TMediaSettingsDependencies, 'startMicrophone' | 'restartWebcam'>;
const useMediaSettings = (inputs: TUseMediaSettingsInputs) => {
	const inputsRef = useLatestRef(inputs);
	const listenerRef = useRef<(() => void) | undefined>(undefined);
	useEffect(
		() =>
			mountMediaSettingsIntegration({
				getInputs: () => inputsRef.current,
				subscribeInputs: (listener) => {
					listenerRef.current = listener;
					return () => {
						listenerRef.current = undefined;
					};
				},
				startMicrophone: () => inputsRef.current.startMicrophone(),
				restartWebcam: () => inputsRef.current.restartWebcam(),
				log: logVoice,
				error: (message) => toast.error(message),
			}),
		[],
	);
	useEffect(() => {
		void inputs.devices;
		void inputs.currentVoiceChannelId;
		void inputs.webcamEnabled;
		listenerRef.current?.();
	}, [inputs.devices, inputs.currentVoiceChannelId, inputs.webcamEnabled]);
};

export { useMediaSettings };
