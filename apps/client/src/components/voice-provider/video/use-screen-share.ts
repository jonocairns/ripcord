import { useCallback, useLayoutEffect, useRef } from 'react';
import { toast } from 'sonner';
import { requestScreenShareSelection } from '@/features/dialogs/actions';
import { logVoice, traceSentrySpan } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import {
	createScreenShareController,
	mountScreenShareController,
	type TScreenShareDependencies,
} from './screen-share-controller';

type TUseScreenShareInputs = Pick<
	TScreenShareDependencies,
	'getProducerTransport' | 'getRtpCapabilities' | 'publishStream' | 'closeProducer' | 'shareAudio'
> & { devices: ReturnType<TScreenShareDependencies['getDevices']> };
const useScreenShare = (inputs: TUseScreenShareInputs) => {
	const inputsRef = useLatestRef(inputs);
	const controllerRef = useRef<ReturnType<typeof createScreenShareController> | undefined>(undefined);
	if (!controllerRef.current)
		controllerRef.current = createScreenShareController({
			getDevices: () => inputsRef.current.devices,
			getProducerTransport: () => inputsRef.current.getProducerTransport(),
			getRtpCapabilities: () => inputsRef.current.getRtpCapabilities(),
			publishStream: (stream) => inputsRef.current.publishStream(stream),
			closeProducer: (id) => inputsRef.current.closeProducer(id),
			// Keep coordination one-way: video passes its liveness getter to audio start.
			shareAudio: {
				stop: () => inputsRef.current.shareAudio.stop(),
				awaitTeardown: () => inputsRef.current.shareAudio.awaitTeardown(),
				adoptDisplayAudio: (stream) => inputsRef.current.shareAudio.adoptDisplayAudio(stream),
				discardDisplayAudio: (stream) => inputsRef.current.shareAudio.discardDisplayAudio(stream),
				start: (options) => inputsRef.current.shareAudio.start(options),
			},
			getDesktopBridge,
			requestSelection: requestScreenShareSelection,
			acquire: (options) => navigator.mediaDevices.getDisplayMedia(options),
			warning: (message) => toast.warning(message),
			log: logVoice,
			setInterval: (handler, delayMs) => setInterval(handler, delayMs),
			clearInterval: (handle) => clearInterval(handle),
			now: () => Date.now(),
		});
	const controller = controllerRef.current;
	useLayoutEffect(() => mountScreenShareController(controller), [controller]);
	const start = useCallback(
		(...args: Parameters<typeof controller.start>) =>
			traceSentrySpan(
				{
					name: 'voice.screen_share_start',
					op: 'voice.screen_share',
					attributes: {
						'voice.screen_audio_mode': inputsRef.current.devices.screenAudioMode,
						'voice.desktop_selection': args[0] !== undefined,
					},
				},
				() => controller.start(...args),
			),
		[controller],
	);
	return { controller, start };
};

export { useScreenShare };
