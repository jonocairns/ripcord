import { StreamKind } from '@sharkord/shared';
import { useLayoutEffect, useRef } from 'react';
import { toast } from 'sonner';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { createDesktopAppAudioPipeline } from '../desktop-app-audio';
import {
	createShareAudioController,
	mountShareAudioController,
	type TShareAudioDependencies,
} from '../share-audio-controller';

type TUseShareAudioInputs = Pick<
	TShareAudioDependencies,
	'getProducerTransport' | 'isScreenVideoLive' | 'publishStream'
> & {
	nativeAppAudioIngestEnabled: boolean;
};

// Preserve the saved setting, packaged-build flag and localStorage rollout override.
const isNativeAppAudioIngestEnabled = (settingsEnabled: boolean): boolean => {
	try {
		const override = globalThis.localStorage?.getItem('voice.nativeAppAudio');
		if (override === 'true') return true;
		if (override === 'false') return false;
	} catch {
		/* localStorage may be unavailable; use the build flag below. */
	}
	return settingsEnabled || import.meta.env.VITE_VOICE_NATIVE_APP_AUDIO === 'true';
};

const useShareAudio = (inputs: TUseShareAudioInputs) => {
	const inputsRef = useLatestRef(inputs);
	const controllerRef = useRef<ReturnType<typeof createShareAudioController> | undefined>(undefined);
	if (!controllerRef.current) {
		controllerRef.current = createShareAudioController({
			getDesktopBridge,
			getProducerTransport: () => inputsRef.current.getProducerTransport(),
			isScreenVideoLive: () => inputsRef.current.isScreenVideoLive(),
			isNativeIngestEnabled: () => isNativeAppAudioIngestEnabled(inputsRef.current.nativeAppAudioIngestEnabled),
			createIngest: () => getTRPCClient().voice.createAppAudioIngest.mutate(),
			produceNative: (input) => getTRPCClient().voice.produceAppAudio.mutate(input),
			abortIngest: (transportId) => getTRPCClient().voice.abortAppAudioIngest.mutate({ transportId }),
			closeProducer: (producerId) =>
				getTRPCClient().voice.closeProducer.mutate({ kind: StreamKind.SCREEN_AUDIO, producerId }),
			createPipeline: createDesktopAppAudioPipeline,
			createStream: (tracks) => new MediaStream(tracks),
			publishStream: (stream) => inputsRef.current.publishStream(stream),
			warning: (message) => toast.warning(message),
			log: logVoice,
			setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
			clearTimeout: (handle) => clearTimeout(handle),
		});
	}
	const controller = controllerRef.current;
	// Fence queued recovery and startup before passive executor cleanup/setup.
	useLayoutEffect(() => mountShareAudioController(controller), [controller]);
	return controller;
};

export { useShareAudio };
