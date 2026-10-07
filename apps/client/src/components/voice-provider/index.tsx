import { ChannelPermission, StreamKind } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useChannelCan, useIsConnected } from '@/features/server/hooks';
import { useServerStore } from '@/features/server/slice';
import { useConfirmedOwnVoiceState, useOwnVoiceState } from '@/features/server/voice/hooks';
import { selectVoiceSessionConnectionStatus } from '@/features/server/voice/voice-session-machine';
import { getVoiceSessionState, subscribeVoiceSession } from '@/features/server/voice/voice-session-store';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { useDevices } from '../devices-provider/hooks/use-devices';
import { FloatingPinnedCard } from './floating-pinned-card';
import { useMicrophone } from './microphone/use-microphone';
import { usePushMicKeybinds } from './microphone/use-push-mic-keybinds';
import { useMediaElementRefs } from './remote-media/use-media-element-refs';
import { useRemoteMedia } from './remote-media/use-remote-media';
import { createDeviceRtpCapabilities } from './session/device-rtp-capabilities';
import { createTransportFailurePort } from './session/transport-failure-port';
import { useVoiceSessionRuntime } from './session/use-voice-session-runtime';
import { useShareAudio } from './share-audio/use-share-audio';
import type { TConnectionStatus, TVoiceProvider } from './types';
import { useLocalStreams } from './use-local-streams';
import { useMediaSettings } from './use-media-settings';
import { useTransportStats } from './use-transport-stats';
import { useVoiceControls } from './use-voice-controls';
import { useVoiceStateOperations } from './use-voice-state-operations';
import { useScreenShare } from './video/use-screen-share';
import { useWebcam } from './video/use-webcam';
import { collectVideoSenderMetadata } from './video/video-sender-metadata';
import { createVoiceActivityStore } from './voice-activity';
import { TransportStatsContext, VoiceActivityContext, VoiceProviderContext } from './voice-provider-context';
import { VolumeControlProvider } from './volume-control-provider';

const getVoiceSessionConnectionStatusSnapshot = (): TConnectionStatus =>
	selectVoiceSessionConnectionStatus(getVoiceSessionState());

const subscribeVoiceSessionConnectionStatus = (onStoreChange: () => void): (() => void) =>
	subscribeVoiceSession(onStoreChange);

type TVoiceProviderProps = {
	children: React.ReactNode;
};

const VoiceProvider = memo(({ children }: TVoiceProviderProps) => {
	const connectionStatus = useSyncExternalStore(
		subscribeVoiceSessionConnectionStatus,
		getVoiceSessionConnectionStatusSnapshot,
		getVoiceSessionConnectionStatusSnapshot,
	);
	const ownVoiceState = useOwnVoiceState();
	const ownConfirmedVoiceState = useConfirmedOwnVoiceState();
	const confirmedOwnMicMuted = ownConfirmedVoiceState?.micMuted;
	const currentVoiceChannelId = useCurrentVoiceChannelId();
	const ownUserId = useServerStore((state) => state.ownUserId);
	const voiceSessionReconnectNonce = useServerStore((state) => state.voiceSessionReconnectNonce);
	const isConnected = useIsConnected();
	const channelCan = useChannelCan(currentVoiceChannelId);
	const { devices } = useDevices();
	const voiceActivityStoreRef = useRef(createVoiceActivityStore());
	// Built before the microphone and runtime, which commit terminal mute through
	// it; controls share the same sequence for later user mute/deafen changes.
	const voiceStateOperations = useVoiceStateOperations(currentVoiceChannelId);
	// Remote media and the video owners read device capabilities written by the
	// runtime built after them. Transport failures are the one late-bound edge:
	// the runtime binds this port while mounted.
	const [deviceRtpCapabilities] = useState(createDeviceRtpCapabilities);
	const [transportFailures] = useState(createTransportFailurePort);

	const { getOrCreateRefs, clear: clearMediaElementRefs } = useMediaElementRefs(currentVoiceChannelId);

	const {
		localAudioStream,
		localVideoStream,
		localScreenShareStream,
		localScreenShareAudioStream,
		setLocalAudioStream,
		setLocalVideoStream,
		setLocalScreenShare,
		setLocalScreenShareAudio,
	} = useLocalStreams();

	const localAudioStreamRef = useLatestRef(localAudioStream);
	const [voiceEventRtpCapabilities, setVoiceEventRtpCapabilities] = useState<RtpCapabilities | null>(null);

	const handleVoiceActivityUpdate = useCallback((activity: { userId: number; isSpeaking: boolean }) => {
		// Remote users come from the server relay. For our own id this is the
		// server observer's fallback layer; the dual-source store prefers our
		// local fast-path over it whenever a local reading is available.
		voiceActivityStoreRef.current.setServerUserActivity(activity.userId, {
			isSpeaking: activity.isSpeaking,
		});
	}, []);

	const {
		producerTransport,
		consumerTransport,
		createProducerTransport,
		createConsumerTransport,
		consumeExistingProducers,
		cleanupTransports,
		clearRemoteUserStreams,
		clearExternalStreams,
		captureWatchedRemoteStreams,
		rehydrateWatchIntentOnly,
		acceptStream,
		retryRemoteMedia,
		stopWatchingStream,
		remoteUserStreams,
		externalStreams,
		pendingStreams,
		remoteMediaSubscriptions,
		visibleRemoteMedia,
	} = useRemoteMedia({
		currentVoiceChannelId,
		rtpCapabilities: voiceEventRtpCapabilities,
		reconnectNonce: voiceSessionReconnectNonce,
		getRtpCapabilities: deviceRtpCapabilities.get,
		onTransportFailure: transportFailures.report,
		onVoiceActivityUpdate: handleVoiceActivityUpdate,
	});

	const closeProducerOnServer = useCallback(async (kind: StreamKind, producerId: string) => {
		try {
			await getTRPCClient().voice.closeProducer.mutate({
				kind,
				producerId,
			});
		} catch (error) {
			logVoice('Error closing producer on server', { error, kind, producerId });
		}
	}, []);

	const webcam = useWebcam({
		devices,
		getProducerTransport: () => producerTransport.current,
		getRtpCapabilities: deviceRtpCapabilities.get,
		publishStream: setLocalVideoStream,
		closeProducer: (id) => {
			void closeProducerOnServer(StreamKind.VIDEO, id);
		},
	});
	const { start: startWebcamStream, stop: stopWebcamStream } = webcam;

	// Audio receives video liveness per start/recovery call, so it needs no
	// reference to the screen owner built after it.
	const shareAudio = useShareAudio({
		nativeAppAudioIngestEnabled: devices.nativeAppAudioIngestEnabled,
		getProducerTransport: () => producerTransport.current,
		publishStream: setLocalScreenShareAudio,
	});
	const { controller: screenShare, start: startScreenShareStream } = useScreenShare({
		devices,
		getProducerTransport: () => producerTransport.current,
		getRtpCapabilities: deviceRtpCapabilities.get,
		publishStream: setLocalScreenShare,
		closeProducer: (id) => {
			void closeProducerOnServer(StreamKind.SCREEN, id);
		},
		shareAudio,
	});
	const { stop: stopScreenShareStream, requestSelection: requestDesktopScreenShareSelection } = screenShare;

	const getVideoSenderMetadata = useCallback(
		() =>
			collectVideoSenderMetadata([
				{ getProducer: screenShare.getProducer, label: 'Screen share' },
				{ getProducer: webcam.getProducer, label: 'Webcam' },
			]),
		[screenShare, webcam],
	);

	const {
		store: transportStatsStore,
		startMonitoring,
		stopMonitoring,
		resetStats,
	} = useTransportStats(getVideoSenderMetadata);

	const microphone = useMicrophone({
		devices,
		currentVoiceChannelId,
		localAudioStream,
		isConnected,
		ownUserId,
		micMuted: ownVoiceState.micMuted,
		producerTransport,
		setLocalAudioStream,
		closeProducerOnServer,
		setLocalActivity: (userId, isSpeaking) => voiceActivityStoreRef.current.setLocalUserActivity(userId, isSpeaking),
		commitTerminalMicMuted: () => {
			void voiceStateOperations.commitTerminalMicMuted();
		},
	});
	const { start: startMicStream } = microphone;

	useMediaSettings({
		devices,
		currentVoiceChannelId,
		webcamEnabled: ownVoiceState.webcamEnabled,
		startMicrophone: startMicStream,
		restartWebcam: webcam.restart,
	});

	const runtime = useVoiceSessionRuntime({
		currentVoiceChannelId,
		isConnected,
		voiceSessionReconnectNonce,
		canSpeak: channelCan(ChannelPermission.SPEAK),
		getLocalAudioStream: () => localAudioStreamRef.current,
		microphone,
		webcam,
		screenShare,
		shareAudio,
		getProducerTransport: () => producerTransport.current,
		getConsumerTransport: () => consumerTransport.current,
		createProducerTransport,
		createConsumerTransport,
		consumeExistingProducers,
		cleanupTransports,
		clearRemoteUserStreams,
		clearExternalStreams,
		clearMediaElementRefs,
		clearActivity: () => voiceActivityStoreRef.current.clearAll(),
		startMonitoring,
		stopMonitoring,
		resetStats,
		deviceRtpCapabilities,
		transportFailures,
		publishRtpCapabilities: setVoiceEventRtpCapabilities,
		captureWatchedRemoteStreams,
		rehydrateWatchIntentOnly,
	});
	const { init } = runtime;

	const { isStartingScreenShare, setMicMuted, toggleMic, toggleSound, toggleWebcam, toggleScreenShare } =
		useVoiceControls({
			voiceStateOperations,
			startMicStream,
			localAudioStream,
			setMicProcessingMuted: microphone.setMuted,
			startWebcamStream,
			stopWebcamStream,
			startScreenShareStream,
			stopScreenShareStream,
			requestScreenShareSelection: getDesktopBridge() ? requestDesktopScreenShareSelection : undefined,
			isScreenShareLive: screenShare.isLive,
		});

	usePushMicKeybinds({
		pushToTalkKeybind: devices.pushToTalkKeybind,
		pushToMuteKeybind: devices.pushToMuteKeybind,
		pushReleaseDelayMs: devices.pushReleaseDelayMs,
		currentVoiceChannelId,
		canSpeak: channelCan(ChannelPermission.SPEAK),
		micMuted: ownVoiceState.micMuted,
		soundMuted: ownVoiceState.soundMuted,
		confirmedMicMuted: confirmedOwnMicMuted,
		setMicMuted,
	});

	useEffect(() => {
		// Reference the dep so the effect re-runs on channel change; the body
		// only cares that the channel changed, not what the new value is.
		void currentVoiceChannelId;
		voiceActivityStoreRef.current.clearAll();
	}, [currentVoiceChannelId]);

	const contextValue = useMemo<TVoiceProvider>(
		() => ({
			connectionStatus,
			getOrCreateRefs,
			acceptStream,
			retryRemoteMedia,
			stopWatchingStream,
			init,

			isStartingScreenShare,
			setMicMuted,
			toggleMic,
			toggleSound,
			toggleWebcam,
			toggleScreenShare,
			ownVoiceState,

			localAudioStream,
			localVideoStream,
			localScreenShareStream,
			localScreenShareAudioStream,

			remoteUserStreams,
			externalStreams,
			pendingStreams,
			remoteMediaSubscriptions,
			visibleRemoteMedia,
		}),
		[
			connectionStatus,
			getOrCreateRefs,
			acceptStream,
			retryRemoteMedia,
			stopWatchingStream,
			init,

			isStartingScreenShare,
			setMicMuted,
			toggleMic,
			toggleSound,
			toggleWebcam,
			toggleScreenShare,
			ownVoiceState,

			localAudioStream,
			localVideoStream,
			localScreenShareStream,
			localScreenShareAudioStream,
			remoteUserStreams,
			externalStreams,
			pendingStreams,
			remoteMediaSubscriptions,
			visibleRemoteMedia,
		],
	);

	return (
		<VoiceProviderContext.Provider value={contextValue}>
			<VoiceActivityContext.Provider value={voiceActivityStoreRef.current}>
				<TransportStatsContext.Provider value={transportStatsStore}>
					<VolumeControlProvider>
						<div className="relative flex min-h-0 flex-1 flex-col">
							<FloatingPinnedCard
								remoteUserStreams={remoteUserStreams}
								externalStreams={externalStreams}
								localScreenShareStream={localScreenShareStream}
								localVideoStream={localVideoStream}
							/>
							{children}
						</div>
					</VolumeControlProvider>
				</TransportStatsContext.Provider>
			</VoiceActivityContext.Provider>
		</VoiceProviderContext.Provider>
	);
});

export { VoiceProvider };
