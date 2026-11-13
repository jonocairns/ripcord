import { ChannelPermission, StreamKind } from '@sharkord/shared';
import type { AppData, Transport } from 'mediasoup-client/types';
import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { canUseChannel } from '@/features/server/channels/can-use-channel';
import { channelByIdSelector } from '@/features/server/channels/selectors';
import { useServerStore } from '@/features/server/slice';
import { ownMicWantedSelector, ownTransmittingSelector } from '@/features/server/voice/selectors';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { getTRPCClientIfInitialized } from '@/lib/trpc';
import type { TVoiceStateOperations } from '../voice-state-operation';
import { getStoredVolume, OWN_MIC_VOLUME_KEY } from '../volume-control-storage';
import { startLocalVoiceActivityMonitor } from './local-voice-activity';
import { createMicAudioProcessingPipeline } from './mic-audio-processing';
import { createMicGainPipeline } from './mic-gain-pipeline';
import { createMicrophoneIntegration, type TMicrophoneIntegrationInputs } from './microphone-integration';
import { mountOwnMicGateSync } from './own-mic-gate-sync';
import { useMicrophonePipelineControllerLifecycle } from './use-microphone-pipeline-controller-lifecycle';

type TUseMicrophoneParams = TMicrophoneIntegrationInputs & {
	micMuted: boolean;
	voiceStateOperations: TVoiceStateOperations;
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
			canSpeak: (channel) => canUseChannel(useServerStore.getState(), channel, ChannelPermission.SPEAK),
			getInputs: () => inputsRef.current,
			isMicMuted: () => !ownMicWantedSelector(useServerStore.getState()),
			isTransmitGateOpen: () => ownTransmittingSelector(useServerStore.getState()),
			beginOperation: () => inputsRef.current.voiceStateOperations.begin(),
			isOperationCurrent: (token) => inputsRef.current.voiceStateOperations.isCurrent(token),
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
	useEffect(
		() =>
			mountOwnMicGateSync({
				isTransmitting: () => ownTransmittingSelector(useServerStore.getState()),
				subscribe: useServerStore.subscribe,
				apply: integration.setMuted,
			}),
		[integration],
	);
	// Activate and fence queued work before passive executor setup/cleanup. The
	// same retained integration can be mounted again during Strict Mode replay.
	useMicrophonePipelineControllerLifecycle(integration);
	useEffect(() => {
		// Render inputs trigger reconciliation; operations read committed values.
		void inputs.currentVoiceChannelId;
		void inputs.devices.microphoneId;
		void inputs.hasServerSession;
		void inputs.ownUserId;
		void inputs.micMuted;
		void inputs.canSpeak;
		integration.syncInputs();
	}, [
		integration,
		inputs.currentVoiceChannelId,
		inputs.devices.microphoneId,
		inputs.hasServerSession,
		inputs.ownUserId,
		inputs.micMuted,
		inputs.canSpeak,
	]);
	return integration;
};

export { useMicrophone };
