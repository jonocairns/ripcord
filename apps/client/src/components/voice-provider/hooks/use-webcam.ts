import { useLayoutEffect, useRef } from 'react';
import { sendOwnVoiceStateUpdate, updateOwnVoiceState } from '@/features/server/voice/actions';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { createWebcamController, mountWebcamController, type TWebcamDependencies } from '../webcam-controller';

type TUseWebcamInputs = Pick<
	TWebcamDependencies,
	'getProducerTransport' | 'getRtpCapabilities' | 'publishStream' | 'closeProducer'
> & { devices: ReturnType<TWebcamDependencies['getDevices']> };
const useWebcam = (inputs: TUseWebcamInputs) => {
	const inputsRef = useLatestRef(inputs);
	const controllerRef = useRef<ReturnType<typeof createWebcamController> | undefined>(undefined);
	if (!controllerRef.current)
		controllerRef.current = createWebcamController({
			getDevices: () => inputsRef.current.devices,
			getProducerTransport: () => inputsRef.current.getProducerTransport(),
			getRtpCapabilities: () => inputsRef.current.getRtpCapabilities(),
			acquire: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
			publishStream: (stream) => inputsRef.current.publishStream(stream),
			closeProducer: (id) => inputsRef.current.closeProducer(id),
			onTrackEnded: () => {
				updateOwnVoiceState({ webcamEnabled: false });
				void sendOwnVoiceStateUpdate({ webcamEnabled: false }).catch((error) => {
					logVoice('Error syncing webcam state after native track end', { error });
				});
			},
			log: logVoice,
		});
	const controller = controllerRef.current;
	useLayoutEffect(() => mountWebcamController(controller), [controller]);
	return controller;
};

export { useWebcam };
