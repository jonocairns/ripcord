import { StreamKind } from '@sharkord/shared';
import type { AppData, Transport } from 'mediasoup-client/types';
import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { channelByIdSelector } from '@/features/server/channels/selectors';
import { useServerStore } from '@/features/server/slice';
import { ownVoiceStateSelector } from '@/features/server/voice/selectors';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { getTRPCClientIfInitialized } from '@/lib/trpc';
import { startLocalVoiceActivityMonitor } from '../local-voice-activity';
import { createMicAudioProcessingPipeline } from '../mic-audio-processing';
import { createMicGainPipeline } from '../mic-gain-pipeline';
import { createMicrophoneIntegration, type TMicrophoneIntegrationInputs } from '../microphone-integration';
import { getStoredVolume, OWN_MIC_VOLUME_KEY } from '../volume-control-storage';
import { useMicrophonePipelineControllerLifecycle } from './use-microphone-pipeline-controller-lifecycle';

type TUseMicrophoneParams = TMicrophoneIntegrationInputs & {
	micMuted: boolean;
	producerTransport: MutableRefObject<Transport<AppData> | undefined>;
	setLocalAudioStream: Dispatch<SetStateAction<MediaStream | undefined>>;
	closeProducerOnServer: (kind: StreamKind, producerId: string) => Promise<void>;
	setLocalActivity: (userId: number, isSpeaking: boolean | undefined) => void;
	commitTerminalMicMuted: () => void;
};

const useMicrophone = (inputs: TUseMicrophoneParams) => {
	const inputsRef = useLatestRef(inputs);
	const integrationRef = useRef<ReturnType<typeof createMicrophoneIntegration> | undefined>(undefined);
	if (!integrationRef.current) {
		integrationRef.current = createMicrophoneIntegration({
			getInputs: () => inputsRef.current,
			isMicMuted: () => ownVoiceStateSelector(useServerStore.getState()).micMuted,
			getProducerTransport: () => inputsRef.current.producerTransport.current,
			getChannelSettings: () => {
				const channelId = inputsRef.current.currentVoiceChannelId;
				return channelId === undefined ? undefined : channelByIdSelector(useServerStore.getState(), channelId);
			},
			getMediaDevices: () => navigator.mediaDevices,
			getVolumeEventTarget: () => window,
			getStoredVolume: () => getStoredVolume(OWN_MIC_VOLUME_KEY),
			createProcessingPipeline: createMicAudioProcessingPipeline,
			createGainPipeline: createMicGainPipeline,
			publishLocalStream: (stream) => {
				inputsRef.current.setLocalAudioStream(stream);
				return {
					stream,
					remove: () => inputsRef.current.setLocalAudioStream((current) => (current === stream ? undefined : current)),
				};
			},
			closeProducerOnServer: (producerId) => {
				void inputsRef.current.closeProducerOnServer(StreamKind.AUDIO, producerId);
			},
			startActivityMonitor: startLocalVoiceActivityMonitor,
			setLocalActivity: (userId, isSpeaking) => inputsRef.current.setLocalActivity(userId, isSpeaking),
			broadcastActivity: (activity) => {
				const client = getTRPCClientIfInitialized();
				if (client) void client.voice.updateActivity.mutate(activity).catch(() => {});
			},
			commitTerminalMicMuted: () => inputsRef.current.commitTerminalMicMuted(),
			error: (message) => toast.error(message),
			log: logVoice,
			now: () => Date.now(),
			setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
			clearTimeout: (handle) => clearTimeout(handle),
		});
	}
	const integration = integrationRef.current;
	// Activate and fence queued work before passive executor setup/cleanup. The
	// same retained integration can be mounted again during Strict Mode replay.
	useMicrophonePipelineControllerLifecycle(integration);
	useEffect(() => {
		// Render inputs trigger reconciliation; operations read committed values.
		void inputs.currentVoiceChannelId;
		void inputs.devices.microphoneId;
		void inputs.isConnected;
		void inputs.ownUserId;
		void inputs.micMuted;
		integration.syncInputs();
	}, [
		integration,
		inputs.currentVoiceChannelId,
		inputs.devices.microphoneId,
		inputs.isConnected,
		inputs.ownUserId,
		inputs.micMuted,
	]);
	return integration;
};

export { useMicrophone };
