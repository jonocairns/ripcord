import {
	ChannelPermission,
	StreamKind,
	type TExternalStream,
	type TVoiceTransportFailureEvent,
} from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useChannelCan, useIsConnected } from '@/features/server/hooks';
import { useServerStore } from '@/features/server/slice';
import { useConfirmedOwnVoiceState, useOwnVoiceState } from '@/features/server/voice/hooks';
import {
	selectVoiceSessionConnectionStatus,
	type TWatchedExternalStreamsSnapshot,
	type TWatchedRemoteStreamsSnapshot,
} from '@/features/server/voice/voice-session-machine';
import { getVoiceSessionState, subscribeVoiceSession } from '@/features/server/voice/voice-session-store';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { useDevices } from '../devices-provider/hooks/use-devices';
import { FloatingPinnedCard } from './floating-pinned-card';
import {
	createRemoteMediaConsumeStartPublication,
	type TRemoteMediaConsumeStartPublication,
} from './hooks/remote-media-consume-start-publication';
import { type TRemoteMediaRepairIdentity, useRemoteMediaSubscriptions } from './hooks/remote-media-subscriptions';
import { useLocalStreams } from './hooks/use-local-streams';
import { useMediaSettings } from './hooks/use-media-settings';
import { useMicrophone } from './hooks/use-microphone';
import { getPendingStreamKey, type TExternalStreamTrackPresence } from './hooks/use-pending-streams';
import { usePushMicKeybinds } from './hooks/use-push-mic-keybinds';
import { useRemoteMediaConsumeRunner } from './hooks/use-remote-media-consume-runner';
import { useRemoteMediaRepairRunner } from './hooks/use-remote-media-repair-runner';
import { useRemoteStreams } from './hooks/use-remote-streams';
import { useScreenShare } from './hooks/use-screen-share';
import { useShareAudio } from './hooks/use-share-audio';
import { useTransportStats } from './hooks/use-transport-stats';
import { useTransports } from './hooks/use-transports';
import { useVoiceControls } from './hooks/use-voice-controls';
import { useVoiceEvents } from './hooks/use-voice-events';
import { useVoiceSessionRuntime } from './hooks/use-voice-session-runtime';
import { useWebcam } from './hooks/use-webcam';
import type { AudioVideoRefs, TConnectionStatus, TVoiceProvider } from './types';
import { createVoiceActivityStore } from './voice-activity';
import {
	createEmptyAudioVideoRefs,
	TransportStatsContext,
	VoiceActivityContext,
	VoiceProviderContext,
} from './voice-provider-context';
import { VolumeControlProvider } from './volume-control-provider';

const getVoiceSessionConnectionStatusSnapshot = (): TConnectionStatus =>
	selectVoiceSessionConnectionStatus(getVoiceSessionState());

const subscribeVoiceSessionConnectionStatus = (onStoreChange: () => void): (() => void) =>
	subscribeVoiceSession(onStoreChange);

type TChannelExternalStreams = {
	[streamId: number]: TExternalStream;
};

const EMPTY_CHANNEL_EXTERNAL_STREAMS: TChannelExternalStreams = {};

type TVoiceProviderProps = {
	children: React.ReactNode;
};

const VoiceProvider = memo(({ children }: TVoiceProviderProps) => {
	const connectionStatus = useSyncExternalStore(
		subscribeVoiceSessionConnectionStatus,
		getVoiceSessionConnectionStatusSnapshot,
		getVoiceSessionConnectionStatusSnapshot,
	);
	const audioVideoRefsMap = useRef<Map<number, AudioVideoRefs>>(new Map());
	const ownVoiceState = useOwnVoiceState();
	const ownConfirmedVoiceState = useConfirmedOwnVoiceState();
	const confirmedOwnMicMuted = ownConfirmedVoiceState?.micMuted;
	const currentVoiceChannelId = useCurrentVoiceChannelId();
	const ownUserId = useServerStore((state) => state.ownUserId);
	const voiceSessionReconnectNonce = useServerStore((state) => state.voiceSessionReconnectNonce);
	const isConnected = useIsConnected();
	const channelCan = useChannelCan(currentVoiceChannelId);
	const currentChannelExternalStreams = useServerStore<TChannelExternalStreams>((state) => {
		if (currentVoiceChannelId === undefined) {
			return EMPTY_CHANNEL_EXTERNAL_STREAMS;
		}

		return state.externalStreamsMap[currentVoiceChannelId] ?? EMPTY_CHANNEL_EXTERNAL_STREAMS;
	});
	const { devices } = useDevices();
	const voiceActivityStoreRef = useRef(createVoiceActivityStore());
	const commitTerminalMicMutedRef = useRef<(() => Promise<void>) | undefined>(undefined);

	const getOrCreateRefs = useCallback((remoteId: number): AudioVideoRefs => {
		if (!audioVideoRefsMap.current.has(remoteId)) {
			audioVideoRefsMap.current.set(remoteId, createEmptyAudioVideoRefs());
		}

		return audioVideoRefsMap.current.get(remoteId)!;
	}, []);

	// Without eviction, every user who passed through any voice channel during
	// this provider's lifetime kept an entry here. Prune anything that's no
	// longer present in the current channel's voice users or external streams,
	// and clear the whole map when leaving voice.
	const currentVoiceChannelUsers = useServerStore((state) =>
		currentVoiceChannelId !== undefined ? state.voiceMap[currentVoiceChannelId]?.users : undefined,
	);
	const currentVoiceChannelExternalsForEviction = useServerStore((state) =>
		currentVoiceChannelId !== undefined ? state.externalStreamsMap[currentVoiceChannelId] : undefined,
	);

	useEffect(() => {
		if (currentVoiceChannelId === undefined) {
			audioVideoRefsMap.current.clear();
			return;
		}

		const validIds = new Set<number>();

		if (currentVoiceChannelUsers) {
			for (const id of Object.keys(currentVoiceChannelUsers)) {
				validIds.add(Number(id));
			}
		}

		if (currentVoiceChannelExternalsForEviction) {
			for (const id of Object.keys(currentVoiceChannelExternalsForEviction)) {
				validIds.add(Number(id));
			}
		}

		for (const remoteId of audioVideoRefsMap.current.keys()) {
			if (!validIds.has(remoteId)) {
				audioVideoRefsMap.current.delete(remoteId);
			}
		}
	}, [currentVoiceChannelId, currentVoiceChannelUsers, currentVoiceChannelExternalsForEviction]);

	const {
		addExternalStreamTrack,
		removeExternalStreamTrack,
		removeExternalStream,
		clearExternalStreams,
		addRemoteUserStream,
		removeRemoteUserStream,
		clearRemoteUserStreamsForUser,
		clearRemoteUserStreams,
		externalStreams,
		remoteUserStreams,
	} = useRemoteStreams();
	const {
		remoteMediaSubscriptions,
		remoteMediaCommands,
		pendingStreams,
		visibleRemoteMedia,
		clearRemoteMediaCommands,
		addPendingStream,
		removePendingStream,
		clearPendingStreamsForUser,
		clearAllPendingStreams,
		reconcilePendingStreams,
		markRepairAttemptStarted,
		markWatchRequested,
		markWatchStopped,
		markRetryRequested,
		rehydrateWatchIntentOnly,
		markConsumeStarted,
		markConsumeSucceeded,
		markConsumeFailed,
		markConsumerClosed,
		clearExternalStream: clearRemoteMediaExternalStream,
	} = useRemoteMediaSubscriptions();
	const remoteMediaSubscriptionsRef = useLatestRef(remoteMediaSubscriptions);
	const pendingStreamsRef = useLatestRef(pendingStreams);
	const consumeStartPublicationRef = useRef<TRemoteMediaConsumeStartPublication | undefined>(undefined);
	if (!consumeStartPublicationRef.current) {
		consumeStartPublicationRef.current = createRemoteMediaConsumeStartPublication();
	}
	const consumeStartPublication = consumeStartPublicationRef.current;
	useEffect(() => {
		consumeStartPublication.reconcile(remoteMediaSubscriptions);
	}, [consumeStartPublication, remoteMediaSubscriptions]);
	const publishRemoteMediaConsumeStarted = useCallback(
		(
			remoteId: number,
			kind: StreamKind,
			producerId: string | undefined,
			consumeGeneration: number,
			isManualRetry: boolean,
			signal: AbortSignal,
		): Promise<boolean> => {
			const publication = consumeStartPublication.wait(
				{ remoteId, kind, expectedProducerId: producerId },
				consumeGeneration,
				signal,
			);
			markConsumeStarted(remoteId, kind, producerId, consumeGeneration, isManualRetry);
			return publication;
		},
		[consumeStartPublication, markConsumeStarted],
	);
	const isRemoteMediaProducerCurrent = useCallback((remoteId: number, kind: StreamKind, producerId: string) => {
		const subscription = remoteMediaSubscriptionsRef.current.get(getPendingStreamKey(remoteId, kind));

		return (
			subscription?.producerPresent === true &&
			(subscription.producerId === undefined || subscription.producerId === producerId)
		);
	}, []);
	const isRemoteMediaRepairIdentityCurrent = useCallback((identity: TRemoteMediaRepairIdentity) => {
		const subscription = remoteMediaSubscriptionsRef.current.get(identity.key);

		return (
			currentVoiceChannelIdRef.current === identity.channelId &&
			subscription?.producerPresent === true &&
			subscription.remoteId === identity.remoteId &&
			subscription.kind === identity.kind &&
			subscription.producerId === identity.producerId
		);
	}, []);

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

	const currentVoiceChannelIdRef = useLatestRef(currentVoiceChannelId);
	const localAudioStreamRef = useLatestRef(localAudioStream);
	const runtimeRef = useRef<ReturnType<typeof useVoiceSessionRuntime> | undefined>(undefined);
	const onTransportFailure = useCallback((failure?: TVoiceTransportFailureEvent) => {
		runtimeRef.current?.onTransportFailure(failure);
	}, []);
	const [voiceEventRtpCapabilities, setVoiceEventRtpCapabilities] = useState<RtpCapabilities | null>(null);

	const {
		producerTransport,
		consumerTransport,
		createProducerTransport,
		createConsumerTransport,
		consume,
		repairRemoteProducer,
		consumeExistingProducers,
		closeConsumer,
		cleanupTransports,
		getActiveConsumerProducerId,
		isTransportFailureCurrent,
		stopWatchingStream,
	} = useTransports({
		addExternalStreamTrack,
		removeExternalStreamTrack,
		addRemoteUserStream,
		removeRemoteUserStream,
		addPendingStream,
		removePendingStream,
		clearAllPendingStreams,
		reconcilePendingStreams,
		markWatchStopped,
		markConsumeStarted: publishRemoteMediaConsumeStarted,
		markConsumeSucceeded,
		markConsumeFailed,
		markConsumerClosed,
		isProducerCurrent: isRemoteMediaProducerCurrent,
		isRepairIdentityCurrent: isRemoteMediaRepairIdentityCurrent,
		onTransportFailure,
	});

	const getExternalStreamTrackPresence = useCallback((): TExternalStreamTrackPresence => {
		const tracks: TExternalStreamTrackPresence = {};

		Object.entries(currentChannelExternalStreams).forEach(([streamId, stream]) => {
			tracks[Number(streamId)] = stream.tracks;
		});

		return tracks;
	}, [currentChannelExternalStreams]);

	const getPendingStreamProducerId = useCallback(
		(remoteId: number, kind: StreamKind): string | undefined =>
			pendingStreamsRef.current.get(getPendingStreamKey(remoteId, kind))?.producerId,
		[],
	);

	const captureWatchedRemoteStreams = useCallback((): TWatchedRemoteStreamsSnapshot => {
		const watchedRemoteStreams: Record<number, StreamKind[]> = {};
		const watchedExternalStreams: Record<number, TWatchedExternalStreamsSnapshot> = {};

		remoteMediaSubscriptionsRef.current.forEach((subscription) => {
			if (!subscription.desired || subscription.kind === StreamKind.AUDIO) {
				return;
			}

			if (
				subscription.kind === StreamKind.VIDEO ||
				subscription.kind === StreamKind.SCREEN ||
				subscription.kind === StreamKind.SCREEN_AUDIO
			) {
				const watchedKinds = watchedRemoteStreams[subscription.remoteId] ?? [];
				watchedKinds.push(subscription.kind);
				watchedRemoteStreams[subscription.remoteId] = watchedKinds;
				return;
			}

			if (subscription.kind === StreamKind.EXTERNAL_AUDIO || subscription.kind === StreamKind.EXTERNAL_VIDEO) {
				const watchedState = watchedExternalStreams[subscription.remoteId] ?? {
					audio: false,
					video: false,
				};

				watchedExternalStreams[subscription.remoteId] = {
					...watchedState,
					audio: watchedState.audio || subscription.kind === StreamKind.EXTERNAL_AUDIO,
					video: watchedState.video || subscription.kind === StreamKind.EXTERNAL_VIDEO,
				};
			}
		});

		return {
			remoteUserStreams: watchedRemoteStreams,
			externalStreams: watchedExternalStreams,
		};
	}, []);

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
		getRtpCapabilities: () => runtimeRef.current?.getRtpCapabilities() ?? null,
		publishStream: setLocalVideoStream,
		closeProducer: (id) => {
			void closeProducerOnServer(StreamKind.VIDEO, id);
		},
	});
	const { start: startWebcamStream, stop: stopWebcamStream } = webcam;

	// Inject video liveness through composition; audio never imports or mutates video.
	const screenVideoLiveRef = useRef<() => boolean>(() => false);
	const shareAudio = useShareAudio({
		nativeAppAudioIngestEnabled: devices.nativeAppAudioIngestEnabled,
		getProducerTransport: () => producerTransport.current,
		isScreenVideoLive: () => screenVideoLiveRef.current(),
		publishStream: setLocalScreenShareAudio,
	});
	const { controller: screenShare, start: startScreenShareStream } = useScreenShare({
		devices,
		getProducerTransport: () => producerTransport.current,
		getRtpCapabilities: () => runtimeRef.current?.getRtpCapabilities() ?? null,
		publishStream: setLocalScreenShare,
		closeProducer: (id) => {
			void closeProducerOnServer(StreamKind.SCREEN, id);
		},
		shareAudio,
	});
	useLayoutEffect(() => {
		screenVideoLiveRef.current = screenShare.isLive;
	}, [screenShare]);
	const { stop: stopScreenShareStream, requestSelection: requestDesktopScreenShareSelection } = screenShare;

	const removeExternalStreamAndSubscription = useCallback(
		(streamId: number) => {
			clearRemoteMediaExternalStream(streamId);
			removeExternalStream(streamId);
		},
		[clearRemoteMediaExternalStream, removeExternalStream],
	);

	const acceptStream = useCallback(
		(remoteId: number, kind: StreamKind) => {
			markWatchRequested(remoteId, kind, getExternalStreamTrackPresence());
		},
		[getExternalStreamTrackPresence, markWatchRequested],
	);

	const retryRemoteMedia = useCallback(
		(remoteId: number, kind: StreamKind) => {
			if (!runtimeRef.current?.getRtpCapabilities()) {
				logVoice('Cannot retry remote media before voice is initialized', {
					remoteId,
					kind,
				});
				return;
			}

			markRetryRequested(remoteId, kind, getExternalStreamTrackPresence());
		},
		[getExternalStreamTrackPresence, markRetryRequested],
	);

	// Surface source labels and configured maxBitrate ceilings to the stats
	// panel, keyed by SSRC so the collector can identify each primary stream.
	const getVideoSenderMetadata = useCallback((): Map<
		number,
		{ configuredMaxBitrate: number | null; label: string }
	> => {
		const metadataBySsrc = new Map<number, { configuredMaxBitrate: number | null; label: string }>();
		const producers = [
			{ producer: screenShare.getProducer(), label: 'Screen share' },
			{ producer: webcam.getProducer(), label: 'Webcam' },
		];

		for (const { producer, label } of producers) {
			const sender = producer?.rtpSender;

			if (!sender) {
				continue;
			}

			for (const encoding of sender.getParameters().encodings ?? []) {
				// `ssrc` is populated at runtime (Chrome) but absent from the DOM lib type.
				const { ssrc } = encoding as RTCRtpEncodingParameters & { ssrc?: number };

				if (typeof ssrc === 'number') {
					metadataBySsrc.set(ssrc, {
						configuredMaxBitrate: typeof encoding.maxBitrate === 'number' ? encoding.maxBitrate : null,
						label,
					});
				}
			}
		}

		return metadataBySsrc;
	}, [screenShare, webcam]);

	const {
		store: transportStatsStore,
		startMonitoring,
		stopMonitoring,
		resetStats,
	} = useTransportStats(getVideoSenderMetadata);

	const handleVoiceActivityUpdate = useCallback((activity: { userId: number; isSpeaking: boolean }) => {
		// Remote users come from the server relay. For our own id this is the
		// server observer's fallback layer; the dual-source store prefers our
		// local fast-path over it whenever a local reading is available.
		voiceActivityStoreRef.current.setServerUserActivity(activity.userId, {
			isSpeaking: activity.isSpeaking,
		});
	}, []);

	useRemoteMediaConsumeRunner({
		currentVoiceChannelId,
		rtpCapabilities: voiceEventRtpCapabilities,
		commands: remoteMediaCommands,
		remoteMediaSubscriptions,
		clearCommands: clearRemoteMediaCommands,
		consume,
		closeConsumer,
		getExternalStreamTrackPresence,
	});

	useEffect(() => {
		Object.entries(currentChannelExternalStreams).forEach(([streamId, stream]) => {
			const numericStreamId = Number(streamId);
			const activeExternalStream = externalStreams[numericStreamId];
			const externalAudioKey = getPendingStreamKey(numericStreamId, StreamKind.EXTERNAL_AUDIO);
			const externalVideoKey = getPendingStreamKey(numericStreamId, StreamKind.EXTERNAL_VIDEO);
			const hasPendingExternalAudio = pendingStreams.has(externalAudioKey);
			const hasPendingExternalVideo = pendingStreams.has(externalVideoKey);
			const externalAudioSubscription = remoteMediaSubscriptions.get(externalAudioKey);
			const externalVideoSubscription = remoteMediaSubscriptions.get(externalVideoKey);

			if (
				stream.tracks.audio &&
				!activeExternalStream?.audioStream &&
				(!hasPendingExternalAudio || externalAudioSubscription?.desired === true)
			) {
				addPendingStream(numericStreamId, StreamKind.EXTERNAL_AUDIO, undefined, getExternalStreamTrackPresence());
			}

			if (
				stream.tracks.video &&
				!activeExternalStream?.videoStream &&
				(!hasPendingExternalVideo || externalVideoSubscription?.desired === true)
			) {
				addPendingStream(numericStreamId, StreamKind.EXTERNAL_VIDEO, undefined, getExternalStreamTrackPresence());
			}
		});
	}, [
		addPendingStream,
		currentChannelExternalStreams,
		externalStreams,
		getExternalStreamTrackPresence,
		pendingStreams,
		remoteMediaSubscriptions,
	]);

	useRemoteMediaRepairRunner({
		currentVoiceChannelId,
		rtpCapabilities: voiceEventRtpCapabilities,
		remoteMediaSubscriptions,
		pendingStreams,
		currentChannelExternalStreams,
		markRepairAttemptStarted,
		repairRemoteProducer,
		getExternalStreamTrackPresence,
	});

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
			void commitTerminalMicMutedRef.current?.();
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
		clearMediaElementRefs: () => audioVideoRefsMap.current.clear(),
		clearActivity: () => voiceActivityStoreRef.current.clearAll(),
		startMonitoring,
		stopMonitoring,
		resetStats,
		publishRtpCapabilities: setVoiceEventRtpCapabilities,
		captureWatchedRemoteStreams,
		rehydrateWatchIntentOnly,
		commitTerminalMicMuted: () => {
			void commitTerminalMicMutedRef.current?.();
		},
	});
	useLayoutEffect(() => {
		runtimeRef.current = runtime;
	}, [runtime]);
	const { init } = runtime;

	const {
		isStartingScreenShare,
		setMicMuted,
		commitTerminalMicMuted,
		toggleMic,
		toggleSound,
		toggleWebcam,
		toggleScreenShare,
	} = useVoiceControls({
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

	commitTerminalMicMutedRef.current = commitTerminalMicMuted;

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

	const syncExistingProducers = useCallback(
		(rtpCapabilities: RtpCapabilities): Promise<void> =>
			consumeExistingProducers(rtpCapabilities, getExternalStreamTrackPresence()),
		[consumeExistingProducers, getExternalStreamTrackPresence],
	);

	useVoiceEvents({
		syncExistingProducers,
		addPendingStream,
		removePendingStream,
		removeRemoteUserStream,
		removeExternalStreamTrack,
		removeExternalStream: removeExternalStreamAndSubscription,
		clearRemoteUserStreamsForUser,
		clearPendingStreamsForUser,
		onVoiceActivityUpdate: handleVoiceActivityUpdate,
		onTransportFailure,
		isTransportFailureCurrent,
		getActiveConsumerProducerId,
		getPendingStreamProducerId,
		getExternalStreamTrackPresence,
		rtpCapabilities: voiceEventRtpCapabilities,
		reconnectNonce: voiceSessionReconnectNonce,
	});

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
