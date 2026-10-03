import {
	ChannelPermission,
	StreamKind,
	type TExternalStream,
	type TRemoteProducerIds,
	type TTransportParams,
	type TVoiceTransportFailureEvent,
	type TVoiceUserState,
} from '@sharkord/shared';
import { Device } from 'mediasoup-client';
import type { AppData, Producer, RtpCapabilities } from 'mediasoup-client/types';
import {
	type MutableRefObject,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { toast } from 'sonner';
import { requestScreenShareSelection as requestScreenShareSelectionDialog } from '@/features/dialogs/actions';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useChannelCan, useIsConnected } from '@/features/server/hooks';
import { useServerStore } from '@/features/server/slice';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import {
	clearOwnVoiceSessionAfterReconnectFailure,
	leaveVoiceSessionAfterRecoveryFailure,
	sendOwnVoiceStateUpdate,
	updateOwnVoiceState,
} from '@/features/server/voice/actions';
import { useConfirmedOwnVoiceState, useOwnVoiceState } from '@/features/server/voice/hooks';
import { setVoiceProviderCleanupHandler } from '@/features/server/voice/provider-cleanup';
import { isVoiceReconnectOnline } from '@/features/server/voice/reconnect-lab-debug';
import { ownVoiceStateSelector } from '@/features/server/voice/selectors';
import type {
	TVoiceSessionRebuildContext,
	TVoiceSessionRestoreContext,
} from '@/features/server/voice/voice-session-command-executor';
import {
	selectVoiceSessionConnectionStatus,
	type TTransportRecoveryTransition,
	type TVoiceSessionCommand,
	type TWatchedExternalStreamsSnapshot,
	type TWatchedRemoteStreamsSnapshot,
} from '@/features/server/voice/voice-session-machine';
import {
	dispatchVoiceSession,
	dispatchVoiceSessionWithResult,
	getVoiceSessionState,
	subscribeVoiceSession,
} from '@/features/server/voice/voice-session-store';
import { logDebug, logVoice, reportError, traceSentrySpan } from '@/helpers/browser-logger';
import { getResWidthHeight } from '@/helpers/get-res-with-height';
import { getTrpcErrorData } from '@/helpers/trpc-error-data';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { getTRPCClient, TRPCClientUnavailableError } from '@/lib/trpc';
import { getDesktopBridge, isDesktopRuntime } from '@/runtime/desktop-bridge';
import { normalizeDesktopCapabilities } from '@/runtime/desktop-capabilities';
import { ScreenAudioMode, type TDesktopScreenShareSelection, type TStartAppAudioCaptureInput } from '@/runtime/types';
import type { TDeviceSettings } from '@/types';
import { useDevices } from '../devices-provider/hooks/use-devices';
import { FloatingPinnedCard } from './floating-pinned-card';
import {
	createRemoteMediaConsumeStartPublication,
	type TRemoteMediaConsumeStartPublication,
} from './hooks/remote-media-consume-start-publication';
import { type TRemoteMediaRepairIdentity, useRemoteMediaSubscriptions } from './hooks/remote-media-subscriptions';
import {
	claimVoiceSessionExecution,
	createVoiceSessionExecutionOwnership,
	invalidateVoiceSessionExecution,
	VoiceSessionExecutionSupersededError,
} from './hooks/session-execution-ownership';
import { useLocalStreams } from './hooks/use-local-streams';
import { useMicrophone } from './hooks/use-microphone';
import { getPendingStreamKey, type TExternalStreamTrackPresence } from './hooks/use-pending-streams';
import { usePushMicKeybinds } from './hooks/use-push-mic-keybinds';
import { useRemoteMediaConsumeRunner } from './hooks/use-remote-media-consume-runner';
import { useRemoteMediaRepairRunner } from './hooks/use-remote-media-repair-runner';
import { useRemoteStreams } from './hooks/use-remote-streams';
import { useScreenShareQualityGuard } from './hooks/use-screen-share-quality-guard';
import { useShareAudio } from './hooks/use-share-audio';
import { useTransportStats } from './hooks/use-transport-stats';
import { useTransports } from './hooks/use-transports';
import { useVoiceControls } from './hooks/use-voice-controls';
import { useVoiceEvents } from './hooks/use-voice-events';
import { useVoiceSessionExecutor } from './hooks/use-voice-session-executor';
import { useWebcam } from './hooks/use-webcam';
import { voiceSessionCommandObserver } from './hooks/voice-session-command-observer';
import { didMicCaptureSettingsChange } from './mic-capture-config';
import type { TMicrophonePreparedPipeline } from './microphone-pipeline-controller';
import { prewarmVoiceEngines } from './prewarm';
import {
	recordTransportRecoverySucceeded,
	resolveTransportFailureDispatchOutcome,
	resolveTransportRecoveryCircuitDecision,
	type TTransportRecoveryCircuitState,
} from './transport-recovery-circuit';
import { recoverTransportMicrophone } from './transport-recovery-microphone';
import type { AudioVideoRefs, TConnectionStatus, TRepublishedLocalMediaState, TVoiceProvider } from './types';
import { applyVideoDegradationPreference, getScreenShareVideoProducerConfig } from './video-producer-config';
import { createVoiceActivityStore } from './voice-activity';
import {
	createEmptyAudioVideoRefs,
	TransportStatsContext,
	VoiceActivityContext,
	VoiceProviderContext,
} from './voice-provider-context';
import { VolumeControlProvider } from './volume-control-provider';
import { didWebcamCaptureSettingsChange } from './webcam-controller';

type TScreenShareStreamHandlers = {
	onVideoTrackStarted?: () => void;
	onVideoTrackEnded?: () => void | Promise<void>;
};

type TRecoveryJoinResult = {
	device: Device;
	routerRtpCapabilities: RtpCapabilities;
	channelUsers: Array<{ userId: number; state: TVoiceUserState }>;
	existingProducers?: TRemoteProducerIds;
	producerTransportParams?: TTransportParams;
	consumerTransportParams?: TTransportParams;
};

type TVoiceBootstrapResult = {
	routerRtpCapabilities: RtpCapabilities;
	channelUsers: Array<{ userId: number; state: TVoiceUserState }>;
	existingProducers?: TRemoteProducerIds;
	producerTransportParams?: TTransportParams;
	consumerTransportParams?: TTransportParams;
};

type TLocalMediaRepublishPlan = {
	tasks: Promise<void>[];
	state: TRepublishedLocalMediaState;
};

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

const RECOVERY_TIMEOUT_MS = 12_000;
const RECOVERY_POST_REJOIN_PRODUCER_REFRESH_DELAY_MS = 350;

const delayVoiceSessionCommand = (milliseconds: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}

		const timeoutId = window.setTimeout(() => {
			signal.removeEventListener('abort', handleAbort);
			resolve();
		}, milliseconds);
		const handleAbort = (): void => {
			window.clearTimeout(timeoutId);
			reject(signal.reason);
		};

		signal.addEventListener('abort', handleAbort, { once: true });
	});

const withTimeout = <T,>(
	promise: Promise<T>,
	timeoutMs: number,
	createTimeoutError: () => Error,
	onTimeout?: () => void,
): Promise<T> => {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		handle = setTimeout(() => {
			onTimeout?.();
			reject(createTimeoutError());
		}, timeoutMs);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (handle !== undefined) {
			clearTimeout(handle);
		}
	});
};

const withRecoveryTimeout = <T,>(promise: Promise<T>, onTimeout?: () => void): Promise<T> =>
	withTimeout(promise, RECOVERY_TIMEOUT_MS, () => new Error('Voice transport recovery timed out'), onTimeout);

const isMissingVoiceSessionError = (error: unknown): boolean => getTrpcErrorData(error)?.code === 'BAD_REQUEST';

const createReconnectAttemptId = (): string => {
	const randomUUID = globalThis.crypto?.randomUUID;

	if (typeof randomUUID === 'function') {
		return randomUUID.call(globalThis.crypto);
	}

	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const VoiceProvider = memo(({ children }: TVoiceProviderProps) => {
	const connectionStatus = useSyncExternalStore(
		subscribeVoiceSessionConnectionStatus,
		getVoiceSessionConnectionStatusSnapshot,
		getVoiceSessionConnectionStatusSnapshot,
	);
	const [voiceEventRtpCapabilities, setVoiceEventRtpCapabilities] = useState<RtpCapabilities | null>(null);
	const deviceRef = useRef<Device | undefined>(undefined);
	const routerRtpCapabilities = useRef<RtpCapabilities | null>(null);
	const sendRtpCapabilities = useRef<RtpCapabilities | null>(null);
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
	// Last onTrackEnded handler passed to publishScreenShareTrack. Transport
	// recovery reuses it so stop-sync side effects survive a producer restart.
	const screenShareTrackEndedHandlerRef = useRef<(() => void | Promise<void>) | undefined>(undefined);
	const previousDevicesRef = useRef<TDeviceSettings | undefined>(undefined);
	const voiceActivityStoreRef = useRef(createVoiceActivityStore());
	const sessionExecutionOwnershipRef = useRef(createVoiceSessionExecutionOwnership());
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
		localScreenShareProducer,
		setLocalAudioStream,
		setLocalVideoStream,
		setLocalScreenShare,
		setLocalScreenShareAudio,
		clearLocalStreams,
	} = useLocalStreams();

	const localAudioStreamRef = useLatestRef(localAudioStream);
	const localScreenShareStreamRef = useLatestRef(localScreenShareStream);

	const voiceCleanupRef = useRef<(() => void) | undefined>(undefined);
	const hasHandledTransportFailureRef = useRef(false);
	const transportRecoveryCircuitRef = useRef<TTransportRecoveryCircuitState | undefined>(undefined);
	const currentVoiceChannelIdRef = useLatestRef(currentVoiceChannelId);
	const isConnectedRef = useLatestRef(isConnected);
	const voiceSessionReconnectNonceRef = useLatestRef(voiceSessionReconnectNonce);

	useEffect(() => {
		if (currentVoiceChannelId === undefined) {
			transportRecoveryCircuitRef.current = undefined;
		}
	}, [currentVoiceChannelId]);

	const onTransportFailure = useCallback((failure?: TVoiceTransportFailureEvent) => {
		if (hasHandledTransportFailureRef.current) {
			logVoice('Transport failure already handled, skipping duplicate cleanup');
			return;
		}

		logVoice('Transport failure detected', { failure });

		const channelId = currentVoiceChannelIdRef.current;
		if (!isConnectedRef.current || channelId === undefined) {
			return;
		}
		const phase = getVoiceSessionState().phase;
		if (phase.phase !== 'connected' || phase.channelId !== channelId) return;

		const previousCircuitState = transportRecoveryCircuitRef.current;
		const circuitDecision = resolveTransportRecoveryCircuitDecision({
			state: previousCircuitState,
			channelId,
			generation: phase.generation,
			now: Date.now(),
		});
		let accepted = false;
		const commitAcceptedTransition = (transition: TTransportRecoveryTransition) => {
			const dispatchOutcome = resolveTransportFailureDispatchOutcome({
				circuitDecision,
				transition,
				previousCircuitState,
			});
			transportRecoveryCircuitRef.current = dispatchOutcome.circuitState;
			if (dispatchOutcome.accepted) {
				hasHandledTransportFailureRef.current = true;
				accepted = true;
			}
		};

		if (circuitDecision.action === 'stop') {
			dispatchVoiceSessionWithResult(
				{
					type: 'TransportRecoveryExhausted',
					channelId,
					connectedGeneration: phase.generation,
				},
				commitAcceptedTransition,
			);
		} else {
			dispatchVoiceSessionWithResult(
				{
					type: 'TransportFailed',
					channelId,
					nonce: voiceSessionReconnectNonceRef.current,
					connectedGeneration: phase.generation,
				},
				commitAcceptedTransition,
			);
		}

		if (!accepted) return;

		if (circuitDecision.action === 'stop') {
			logVoice('Rapid voice transport recovery exhausted', {
				channelId,
				rapidFailureCount: circuitDecision.state.rapidFailureCount,
				failure,
			});
		}
	}, []);

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
		getRtpCapabilities: () => sendRtpCapabilities.current,
		publishStream: setLocalVideoStream,
		closeProducer: (id) => {
			void closeProducerOnServer(StreamKind.VIDEO, id);
		},
	});
	const { start: startWebcamStream, stop: stopWebcamStream } = webcam;

	const bindProducerCloseHandler = useCallback(
		({
			producer,
			kind,
			producerRef,
			logLabel,
			onCurrentProducerClose,
		}: {
			producer: Producer<AppData>;
			kind: StreamKind;
			producerRef: MutableRefObject<Producer<AppData> | undefined>;
			logLabel: string;
			onCurrentProducerClose?: () => void;
		}) => {
			producer.on('@close', () => {
				logVoice(`${logLabel} producer closed`, {
					producerId: producer.id,
				});

				if (producerRef.current === producer) {
					producerRef.current = undefined;
					onCurrentProducerClose?.();
				}

				void closeProducerOnServer(kind, producer.id);
			});
		},
		[closeProducerOnServer],
	);

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
			if (!sendRtpCapabilities.current) {
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
			{ producer: localScreenShareProducer.current, label: 'Screen share' },
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
	}, [localScreenShareProducer, webcam]);

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

	const ensureVoiceDeviceLoaded = useCallback(async (isCurrent: () => boolean = () => true) => {
		if (deviceRef.current) {
			return deviceRef.current;
		}

		const currentRouterRtpCapabilities = routerRtpCapabilities.current;

		if (!currentRouterRtpCapabilities) {
			throw new Error('Router RTP capabilities not available');
		}

		const device = await Device.factory();
		await device.load({
			routerRtpCapabilities: currentRouterRtpCapabilities,
		});
		if (!isCurrent()) {
			throw new VoiceSessionExecutionSupersededError();
		}

		deviceRef.current = device;
		sendRtpCapabilities.current = device.rtpCapabilities;

		return device;
	}, []);

	const requestVoiceRestoreOrJoin = useCallback(
		async (opts: {
			channelId: number;
			micMuted: boolean;
			soundMuted: boolean;
			reconnectAttemptId: string;
			signal?: AbortSignal;
		}): Promise<TVoiceBootstrapResult> => {
			return traceSentrySpan(
				{
					name: 'voice.restore_or_join',
					op: 'voice.trpc',
					attributes: {
						'voice.reconnect_attempt_id': opts.reconnectAttemptId,
					},
				},
				() =>
					getTRPCClient().voice.restoreOrJoin.mutate(
						{
							channelId: opts.channelId,
							state: {
								micMuted: opts.micMuted,
								soundMuted: opts.soundMuted,
							},
							reconnectAttemptId: opts.reconnectAttemptId,
						},
						{ signal: opts.signal },
					),
			);
		},
		[],
	);

	const rejoinVoiceSession = useCallback(
		async (
			channelId: number,
			options: { isCurrent?: () => boolean; signal?: AbortSignal } = {},
		): Promise<TRecoveryJoinResult> => {
			return traceSentrySpan(
				{
					name: 'voice.rejoin_session',
					op: 'voice.recovery',
					attributes: {},
				},
				async () => {
					const currentOwnVoiceState = ownVoiceStateSelector(useServerStore.getState());
					const {
						routerRtpCapabilities: nextRouterRtpCapabilities,
						producerTransportParams,
						consumerTransportParams,
						existingProducers,
						channelUsers,
					} = await requestVoiceRestoreOrJoin({
						channelId,
						micMuted: currentOwnVoiceState.micMuted,
						soundMuted: currentOwnVoiceState.soundMuted,
						reconnectAttemptId: createReconnectAttemptId(),
						signal: options.signal,
					});

					const device = await Device.factory();
					await device.load({
						routerRtpCapabilities: nextRouterRtpCapabilities,
					});
					if (options.isCurrent && !options.isCurrent()) {
						throw new VoiceSessionExecutionSupersededError();
					}

					return {
						device,
						routerRtpCapabilities: nextRouterRtpCapabilities,
						channelUsers,
						existingProducers,
						producerTransportParams,
						consumerTransportParams,
					};
				},
			);
		},
		[requestVoiceRestoreOrJoin],
	);

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
	const {
		cleanup: cleanupMicAudioPipeline,
		prepare: prepareMicPipeline,
		publish: produceMicTrack,
		start: startMicStream,
	} = microphone;

	const shareAudio = useShareAudio({
		nativeAppAudioIngestEnabled: devices.nativeAppAudioIngestEnabled,
		getProducerTransport: () => producerTransport.current,
		isScreenVideoLive: () =>
			(localScreenShareProducer.current?.track ?? localScreenShareStreamRef.current?.getVideoTracks()[0])
				?.readyState === 'live',
		publishStream: setLocalScreenShareAudio,
	});

	const publishScreenShareTrack = useCallback(
		async (
			stream: MediaStream,
			track: MediaStreamTrack,
			options: {
				onTrackEnded?: () => void | Promise<void>;
				clearStreamOnFailure?: boolean;
				isCurrent?: () => boolean;
			} = {},
		) => {
			const transport = producerTransport.current;
			if (!transport || transport.closed || (options.isCurrent && !options.isCurrent())) {
				throw new VoiceSessionExecutionSupersededError();
			}
			setLocalScreenShare(stream);
			const clearStreamOnFailure = options.clearStreamOnFailure ?? true;
			let screenShareProducer: Producer<AppData> | undefined;

			if (options.onTrackEnded) {
				screenShareTrackEndedHandlerRef.current = options.onTrackEnded;
			}

			const onTrackEnded = options.onTrackEnded ?? screenShareTrackEndedHandlerRef.current;

			try {
				logVoice('Obtained video track', { videoTrack: track });

				track.contentHint = 'motion';

				const requestedScreenResolution = getResWidthHeight(devices?.screenResolution);
				const screenTrackSettings = track.getSettings();
				const videoConfig = getScreenShareVideoProducerConfig({
					rtpCapabilities: sendRtpCapabilities.current,
					preference: devices.videoCodec,
					width: screenTrackSettings.width ?? requestedScreenResolution.width,
					height: screenTrackSettings.height ?? requestedScreenResolution.height,
					frameRate: screenTrackSettings.frameRate ?? devices.screenFramerate,
				});

				screenShareProducer = await transport.produce({
					track,
					...videoConfig,
					// Keep explicit stream cleanup as the only path that stops the
					// browser screen-share capture.
					stopTracks: false,
					appData: { kind: StreamKind.SCREEN },
				});

				if (!screenShareProducer) {
					throw new Error('Failed to create screen share producer');
				}

				const createdScreenShareProducer = screenShareProducer;
				await applyVideoDegradationPreference(createdScreenShareProducer.rtpSender, 'screen share');
				if (
					producerTransport.current !== transport ||
					transport.closed ||
					(options.isCurrent && !options.isCurrent())
				) {
					throw new VoiceSessionExecutionSupersededError();
				}

				localScreenShareProducer.current = createdScreenShareProducer;

				bindProducerCloseHandler({
					producer: createdScreenShareProducer,
					kind: StreamKind.SCREEN,
					producerRef: localScreenShareProducer,
					logLabel: 'Screen share',
				});

				track.onended = () => {
					logVoice('Screen share track ended, cleaning up screen share');

					stream.getVideoTracks().forEach((currentTrack) => {
						currentTrack.stop();
					});
					createdScreenShareProducer.close();
					void shareAudio.stop();

					setLocalScreenShare(undefined);
					void onTrackEnded?.();
				};
			} catch (error) {
				screenShareProducer?.close();
				if (localScreenShareProducer.current === screenShareProducer) {
					localScreenShareProducer.current = undefined;
				}
				if (clearStreamOnFailure) {
					setLocalScreenShare((currentStream) => {
						return currentStream === stream ? undefined : currentStream;
					});
				}
				throw error;
			}
		},
		[
			bindProducerCloseHandler,
			shareAudio,
			devices.screenFramerate,
			devices.screenResolution,
			devices.videoCodec,
			localScreenShareProducer,
			producerTransport,
			setLocalScreenShare,
		],
	);

	useScreenShareQualityGuard({
		screenShareProducerRef: localScreenShareProducer,
		active: localScreenShareStream !== undefined,
	});

	useEffect(() => {
		const previousDevices = previousDevicesRef.current;
		previousDevicesRef.current = devices;

		if (!previousDevices || currentVoiceChannelId === undefined) {
			return;
		}

		const shouldRestartMic = didMicCaptureSettingsChange(previousDevices, devices);
		const shouldRestartWebcam = ownVoiceState.webcamEnabled && didWebcamCaptureSettingsChange(previousDevices, devices);

		if (!shouldRestartMic && !shouldRestartWebcam) {
			return;
		}

		void (async () => {
			if (shouldRestartMic) {
				logVoice('Applying updated microphone settings live');
				const outcome = await startMicStream();
				if (outcome.status === 'failed') {
					logVoice('Failed to apply microphone settings live', { error: outcome.error });
					toast.error('Failed to apply microphone settings');
				}
			}

			if (shouldRestartWebcam) {
				try {
					logVoice('Applying updated webcam settings live');
					stopWebcamStream();
					await startWebcamStream();
				} catch (error) {
					logVoice('Failed to apply webcam settings live', { error });
					toast.error('Failed to apply webcam settings');
				}
			}
		})();
	}, [
		devices,
		currentVoiceChannelId,
		ownVoiceState.webcamEnabled,
		startMicStream,
		startWebcamStream,
		stopWebcamStream,
	]);

	const stopScreenShareStream = useCallback(() => {
		logVoice('Stopping screen share stream');

		localScreenShareStream?.getVideoTracks().forEach((track) => {
			logVoice('Stopping screen share track', { track });

			track.stop();
			localScreenShareStream.removeTrack(track);
		});

		localScreenShareProducer.current?.close();
		localScreenShareProducer.current = undefined;
		screenShareTrackEndedHandlerRef.current = undefined;
		void shareAudio.stop();

		setLocalScreenShare(undefined);
	}, [shareAudio, localScreenShareStream, setLocalScreenShare, localScreenShareProducer]);

	const requestDesktopScreenShareSelection = useCallback(async (): Promise<TDesktopScreenShareSelection | null> => {
		// The dialog opens immediately in a loading state and is populated once
		// the desktop bridge returns. See requestScreenShareSelection.
		return requestScreenShareSelectionDialog({
			defaultAudioMode: devices.screenAudioMode,
			loadData: async () => {
				const desktopBridge = getDesktopBridge();

				if (!desktopBridge) {
					throw new Error('Desktop bridge unavailable');
				}

				const [sources, capabilities] = await Promise.all([
					desktopBridge.listShareSources(),
					desktopBridge.getCapabilities(),
				]);

				return {
					sources,
					capabilities: normalizeDesktopCapabilities(capabilities),
				};
			},
		});
	}, [devices.screenAudioMode]);

	const startScreenShareStream = useCallback(
		async (desktopSelection?: TDesktopScreenShareSelection, handlers: TScreenShareStreamHandlers = {}) => {
			return traceSentrySpan(
				{
					name: 'voice.screen_share_start',
					op: 'voice.screen_share',
					attributes: {
						'voice.screen_audio_mode': devices.screenAudioMode,
						'voice.desktop_selection': desktopSelection !== undefined,
					},
				},
				async () => {
					// Wait for any in-flight desktop audio cleanup from a previous screen
					// share stop so the new sidecar session doesn't conflict with it.
					await shareAudio.awaitTeardown();

					let stream: MediaStream | undefined;

					try {
						logVoice('Starting screen share stream');

						let audioMode = devices.screenAudioMode;
						const desktopBridge = getDesktopBridge();

						if (desktopBridge && desktopSelection) {
							const resolved = await desktopBridge.prepareScreenShare(desktopSelection);
							audioMode = resolved.effectiveMode;

							if (resolved.warning) {
								toast.warning(resolved.warning);
							}
						}

						// Only route system audio through the sidecar when the desktop
						// capture stack advertises support for the sidecar-backed path.
						// Linux uses a best-effort PipeWire mix with self-exclusion, and
						// macOS uses the ScreenCaptureKit helper-backed sidecar path.
						let sidecarSupported = false;
						if (desktopBridge && audioMode === ScreenAudioMode.SYSTEM) {
							try {
								const caps = normalizeDesktopCapabilities(await desktopBridge.getCapabilities());
								sidecarSupported = caps.sidecarAvailable === true && caps.perAppAudio !== 'unsupported';
							} catch {
								// If capabilities check fails, don't attempt sidecar for system audio.
							}
						}

						const sidecarAudioMode =
							audioMode === ScreenAudioMode.APP || (audioMode === ScreenAudioMode.SYSTEM && sidecarSupported)
								? audioMode
								: undefined;
						const useSidecarAudio = desktopBridge && desktopSelection && sidecarAudioMode !== undefined;

						// Always request loopback audio from getDisplayMedia in system mode
						// so it is available as a fallback if the sidecar fails.  When the
						// sidecar successfully captures audio, the loopback track is stopped
						// and removed before the producer is created.
						const shouldCaptureDisplayAudio = audioMode === ScreenAudioMode.SYSTEM;
						const requestedScreenResolution = getResWidthHeight(devices?.screenResolution);

						try {
							stream = await navigator.mediaDevices.getDisplayMedia({
								video: {
									...requestedScreenResolution,
									frameRate: devices?.screenFramerate,
								},
								audio: shouldCaptureDisplayAudio
									? {
											echoCancellation: false,
											noiseSuppression: false,
											autoGainControl: false,
										}
									: false,
							});
						} finally {
							if (desktopSelection?.useSystemPicker) {
								void desktopBridge?.resetScreenSharePicker?.();
							}
						}

						shareAudio.adoptDisplayAudio(stream);
						logVoice('Screen share stream obtained', { stream });

						const videoTrack = stream.getVideoTracks()[0];

						if (videoTrack) {
							await publishScreenShareTrack(stream, videoTrack, {
								onTrackEnded: handlers.onVideoTrackEnded,
							});
							// Surface the active share as soon as the video producer exists.
							// Optional audio setup can continue after the preview is already live.
							handlers.onVideoTrackStarted?.();

							if (useSidecarAudio && desktopBridge && desktopSelection && sidecarAudioMode) {
								const captureInput: TStartAppAudioCaptureInput = {
									sourceId: desktopSelection.sourceId,
								};

								if (sidecarAudioMode === ScreenAudioMode.APP) {
									captureInput.appAudioTargetId = desktopSelection.appAudioTargetId;
								}

								await shareAudio.start({
									displayStream: stream,
									desktopBridge,
									captureInput,
									audioMode: sidecarAudioMode,
								});
							} else {
								await shareAudio.start({ displayStream: stream });
							}

							return videoTrack;
						} else {
							throw new Error('No video track obtained for screen share');
						}
					} catch (error) {
						stream?.getVideoTracks().forEach((track) => {
							track.stop();
						});
						await shareAudio.stop();

						logVoice('Error starting screen share stream', { error });
						throw error;
					}
				},
			);
		},
		[shareAudio, devices.screenAudioMode, devices.screenFramerate, devices.screenResolution, publishScreenShareTrack],
	);

	const cleanup = useCallback(
		(opts?: {
			preserveLocalMedia?: boolean;
			preserveRemoteMediaIntent?: boolean;
			preserveSessionExecution?: boolean;
		}) => {
			logVoice('Running voice provider cleanup', { preserveLocalMedia: opts?.preserveLocalMedia ?? false });
			if (!opts?.preserveSessionExecution) {
				invalidateVoiceSessionExecution(sessionExecutionOwnershipRef.current);
			}

			// When preserving local media (WS-reconnect restore), leave the desktop
			// app-audio pipeline running so a live screen-share audio track survives
			// to be republished; tearing it down would end the track.
			if (opts?.preserveLocalMedia) {
				shareAudio.detachProducer();
			} else {
				void shareAudio.stop();
			}
			void cleanupMicAudioPipeline();
			stopMonitoring();
			resetStats();
			voiceActivityStoreRef.current.clearAll();
			if (opts?.preserveLocalMedia) webcam.detachProducer();
			else webcam.stop();
			clearLocalStreams({ keepVideoAndScreen: opts?.preserveLocalMedia });
			clearRemoteUserStreams();
			clearExternalStreams();
			cleanupTransports({ preserveRemoteMediaIntent: opts?.preserveRemoteMediaIntent === true });
			audioVideoRefsMap.current.clear();
			deviceRef.current = undefined;
			routerRtpCapabilities.current = null;
			sendRtpCapabilities.current = null;
			setVoiceEventRtpCapabilities(null);
		},
		[
			shareAudio,
			stopMonitoring,
			resetStats,
			cleanupMicAudioPipeline,
			clearLocalStreams,
			webcam,
			clearRemoteUserStreams,
			clearExternalStreams,
			cleanupTransports,
		],
	);

	voiceCleanupRef.current = cleanup;

	useEffect(() => {
		setVoiceProviderCleanupHandler(cleanup);

		return () => {
			setVoiceProviderCleanupHandler(undefined);
		};
	}, [cleanup]);

	useEffect(() => {
		// Desktop only: warm the WebRTC engine + audio-capture subsystem once so
		// the first voice join isn't ~1s of cold-start. The microphone is only
		// touched when permission is already granted, so startup never triggers a
		// permission prompt or first-run mic indicator.
		if (isDesktopRuntime()) {
			prewarmVoiceEngines({ warmMicrophoneIfGranted: true });
		}
	}, []);

	// Builds republish tasks for any live local webcam + screen-share (video and
	// audio) tracks onto the current producer transport. Shared by both recovery
	// paths, in-session transport recovery and WS-reconnect restore, so a live
	// screen share survives either. The mic is handled separately by each caller
	// because its re-acquire/republish semantics differ.
	const buildLocalMediaRepublishPlan = useCallback(
		(isCurrent?: () => boolean): TLocalMediaRepublishPlan => {
			const tasks: Promise<void>[] = [];
			const state: TRepublishedLocalMediaState = {};

			const republishWebcam = webcam.republish(isCurrent);
			if (republishWebcam) {
				state.webcamEnabled = true;
				tasks.push(republishWebcam);
			}

			const screenShareStream = localScreenShareStreamRef.current;
			const screenShareTrack = screenShareStream?.getVideoTracks()[0];
			if (screenShareStream && screenShareTrack && screenShareTrack.readyState === 'live') {
				state.sharingScreen = true;
				tasks.push(
					publishScreenShareTrack(screenShareStream, screenShareTrack, {
						clearStreamOnFailure: false,
						isCurrent,
					}),
				);
			}

			const republishAudio = shareAudio.republish(isCurrent);
			if (republishAudio) tasks.push(republishAudio);

			return { tasks, state };
		},
		[webcam, publishScreenShareTrack, shareAudio],
	);

	const syncRepublishedLocalMediaState = useCallback(
		async (state: TRepublishedLocalMediaState, options: { isCurrent?: () => boolean; signal?: AbortSignal } = {}) => {
			if (state.webcamEnabled !== true && state.sharingScreen !== true) {
				return;
			}
			if (options.isCurrent && !options.isCurrent()) {
				throw new VoiceSessionExecutionSupersededError();
			}

			await sendOwnVoiceStateUpdate(state, { signal: options.signal });
			if (options.isCurrent && !options.isCurrent()) {
				throw new VoiceSessionExecutionSupersededError();
			}
			updateOwnVoiceState(state);
		},
		[],
	);

	const init = useCallback(
		async (
			incomingRouterRtpCapabilities: RtpCapabilities,
			channelId: number,
			opts?: {
				producerTransportParams?: TTransportParams;
				consumerTransportParams?: TTransportParams;
				existingProducers?: TRemoteProducerIds;
				// Keep live webcam/screen-share capture alive across the teardown and
				// republish it onto the new transport (WS-reconnect restore). Without
				// this an in-progress screen share is silently dropped on reconnect.
				preserveLocalMedia?: boolean;
				restoreWatchSnapshot?: TWatchedRemoteStreamsSnapshot;
				isCurrentRecovery?: () => boolean;
			},
		) => {
			const microphoneLifecycleLease = microphone.createLifecycleLease();
			const ownsSessionExecution = claimVoiceSessionExecution(sessionExecutionOwnershipRef.current);
			const isCurrent = (): boolean =>
				microphoneLifecycleLease.isCurrent() &&
				ownsSessionExecution() &&
				(opts?.isCurrentRecovery === undefined || opts.isCurrentRecovery());

			return traceSentrySpan(
				{
					name: 'voice.init',
					op: 'voice.join',
					attributes: {
						'voice.prefetched_transports': opts?.producerTransportParams !== undefined,
						'voice.has_existing_producers': opts?.existingProducers !== undefined,
						'voice.preserve_local_media': opts?.preserveLocalMedia === true,
					},
				},
				async () => {
					const throwIfRecoverySuperseded = (): void => {
						if (!isCurrent()) {
							throw new VoiceSessionExecutionSupersededError();
						}
					};

					logVoice('Initializing voice provider', {
						incomingRouterRtpCapabilities,
						channelId,
						prefetched: !!opts?.producerTransportParams,
						preserveLocalMedia: opts?.preserveLocalMedia ?? false,
					});

					let republishedLocalMediaState: TRepublishedLocalMediaState = {};

					cleanup({
						preserveLocalMedia: opts?.preserveLocalMedia,
						preserveRemoteMediaIntent: opts?.restoreWatchSnapshot !== undefined,
						preserveSessionExecution: true,
					});
					throwIfRecoverySuperseded();
					if (opts?.restoreWatchSnapshot !== undefined) {
						rehydrateWatchIntentOnly(opts.restoreWatchSnapshot);
					}
					let micPrepPromise: Promise<TMicrophonePreparedPipeline | undefined> | undefined;
					const dispatchJoinLifecycle = opts?.preserveLocalMedia !== true && opts?.restoreWatchSnapshot === undefined;

					try {
						if (dispatchJoinLifecycle) {
							dispatchVoiceSession({ type: 'JoinRequested', channelId });
						}

						throwIfRecoverySuperseded();
						routerRtpCapabilities.current = incomingRouterRtpCapabilities;

						const device = await Device.factory();

						if (!ownVoiceStateSelector(useServerStore.getState()).micMuted) {
							// Start mic acquisition + WASM pipeline immediately — these have no
							// dependency on the mediasoup device or transports and are the slowest
							// part of startMicStream. Running them concurrently with device.load()
							// and transport creation saves ~200-300ms on join.
							micPrepPromise = prepareMicPipeline(isCurrent).catch((error) => {
								// prepareMicPipeline cleans up after its own failures, and a
								// superseded build must not touch the successor's pipeline —
								// so no shared teardown here.
								logVoice('Error preparing microphone pipeline', { error });
								return undefined;
							});
						}

						await device.load({
							routerRtpCapabilities: incomingRouterRtpCapabilities,
						});
						throwIfRecoverySuperseded();
						deviceRef.current = device;
						sendRtpCapabilities.current = device.rtpCapabilities;

						await Promise.all([
							createProducerTransport(device, opts?.producerTransportParams, isCurrent),
							createConsumerTransport(device, opts?.consumerTransportParams, isCurrent),
						]);
						throwIfRecoverySuperseded();
						setVoiceEventRtpCapabilities(device.rtpCapabilities);

						const [, micPrepResult] = await Promise.all([
							consumeExistingProducers(device.rtpCapabilities, undefined, opts?.existingProducers),
							micPrepPromise,
						]);
						throwIfRecoverySuperseded();

						// Mic failures are non-fatal — voice join continues without a mic.
						if (micPrepResult) {
							try {
								await produceMicTrack(micPrepResult, isCurrent);
							} catch (error) {
								logVoice('Error attaching microphone to transport', { error });

								// Tear down only while this build's pipeline is still the
								// installed one — a detached attempt failing late must not
								// destroy the successor's mic.
								if (microphone.owns(micPrepResult)) {
									await cleanupMicAudioPipeline();
								}
							}
						}
						throwIfRecoverySuperseded();

						// Republish any preserved webcam/screen-share tracks (WS reconnect).
						// On a fresh join there are no live local tracks, so this is a no-op.
						if (opts?.preserveLocalMedia) {
							const republishPlan = buildLocalMediaRepublishPlan(isCurrent);

							if (republishPlan.tasks.length > 0) {
								logVoice('Republishing preserved local media after reconnect restore', {
									taskCount: republishPlan.tasks.length,
								});
								await Promise.all(republishPlan.tasks);
								republishedLocalMediaState = republishPlan.state;
							}

							if (shareAudio.hasDesktopIntent()) {
								void shareAudio.recover().catch((error) => {
									logVoice('Error recovering desktop app audio after reconnect restore', { error });
								});
							}
						}
						throwIfRecoverySuperseded();

						throwIfRecoverySuperseded();
						startMonitoring(producerTransport.current, consumerTransport.current);
						if (dispatchJoinLifecycle) {
							dispatchVoiceSession({ type: 'JoinSucceeded', channelId });
							hasHandledTransportFailureRef.current = false;
						}

						return { republishedLocalMediaState };
					} catch (error) {
						logVoice('Error initializing voice provider', { error });

						const preparedMic = await micPrepPromise;

						// Tear the mic pipeline down only while this init's build still
						// owns the shared refs. A detached recovery attempt (the reconnect
						// runner drains a cancelled attempt for a bounded window, then
						// detaches it) may settle this catch after its successor installed
						// a new pipeline — destroying it here would kill the live mic.
						// When the prep itself failed, it already cleaned up after itself.
						if (preparedMic && microphone.owns(preparedMic)) {
							await cleanupMicAudioPipeline();
						}

						// Lifecycle state belongs to the current attempt; a superseded
						// recovery attempt must not fail its successor's join.
						if (isCurrent()) {
							if (dispatchJoinLifecycle) {
								dispatchVoiceSession({ type: 'JoinFailed', reason: 'join-failed', channelId });
							}
						}

						throw error;
					}
				},
			);
		},
		[
			cleanup,
			prepareMicPipeline,
			produceMicTrack,
			cleanupMicAudioPipeline,
			microphone,
			createProducerTransport,
			createConsumerTransport,
			consumeExistingProducers,
			startMonitoring,
			producerTransport,
			consumerTransport,
			buildLocalMediaRepublishPlan,
			shareAudio,
			rehydrateWatchIntentOnly,
		],
	);

	const requestRecoveryFailureLeave = useCallback(async (): Promise<void> => {
		// Offline terminal cleanup deliberately leaves the server seat to
		// disconnect grace; only a failed request on a live socket is reportable.
		if (!useServerStore.getState().connected) {
			return;
		}

		const didLeave = await leaveVoiceSessionAfterRecoveryFailure();
		if (!didLeave && useServerStore.getState().connected) {
			throw new Error('Failed to send voice.leave after voice recovery failure');
		}
	}, []);

	const leaveAfterFailedTransportRecovery = useCallback(
		async (channelId?: number): Promise<void> => {
			const leaveRequest = channelId === undefined ? undefined : requestRecoveryFailureLeave();

			if (currentVoiceChannelIdRef.current !== undefined) {
				useServerStore.getState().setCurrentVoiceChannelId(undefined);
				useServerStore.getState().updateOwnVoiceState({
					webcamEnabled: false,
					sharingScreen: false,
				});
				useServerStore.getState().setPinnedCard(undefined);
				playSound(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
				toast.info('Voice connection was lost. Rejoin the voice channel manually.');
			}

			voiceCleanupRef.current?.();
			hasHandledTransportFailureRef.current = false;

			await leaveRequest;
		},
		[requestRecoveryFailureLeave],
	);

	const rebuildTransports = useCallback(
		async (
			command: Extract<TVoiceSessionCommand, { type: 'RebuildTransports' }>,
			context: TVoiceSessionRebuildContext,
		): Promise<void> => {
			const ownsSessionExecution = claimVoiceSessionExecution(sessionExecutionOwnershipRef.current);
			const isCurrentAttempt = (): boolean => ownsSessionExecution() && context.isCurrent();
			const restartIfNonceChanged = (): boolean => context.restartIfNonceChanged(voiceSessionReconnectNonceRef.current);

			return traceSentrySpan(
				{
					name: 'voice.transport_recovery',
					op: 'voice.recovery',
					attributes: {},
				},
				async () => {
					try {
						if (!isCurrentAttempt()) {
							throw new VoiceSessionExecutionSupersededError();
						}

						if (!isConnectedRef.current) {
							throw new Error('Voice transport recovery skipped: server connection unavailable');
						}

						if (currentVoiceChannelIdRef.current === undefined) {
							throw new Error('Voice transport recovery skipped: user is no longer in voice');
						}

						if (!routerRtpCapabilities.current) {
							throw new Error('Voice transport recovery skipped: router RTP capabilities unavailable');
						}

						logVoice('Attempting in-session voice transport recovery', {
							attempt: command.attempt + 1,
							channelId: command.channelId,
						});

						stopMonitoring();
						resetStats();
						clearRemoteUserStreams();
						clearExternalStreams();
						setVoiceEventRtpCapabilities(null);
						cleanupTransports({ preserveRemoteMediaIntent: true });
						rehydrateWatchIntentOnly(command.snapshot);

						let device = await withRecoveryTimeout(ensureVoiceDeviceLoaded(isCurrentAttempt));
						if (restartIfNonceChanged()) return;

						let currentRtpCapabilities = device.rtpCapabilities;
						let recoveryJoinResult: TRecoveryJoinResult | undefined;

						try {
							await withRecoveryTimeout(
								Promise.all([
									createProducerTransport(device, undefined, isCurrentAttempt),
									createConsumerTransport(device, undefined, isCurrentAttempt),
								]),
							);
						} catch (error) {
							const recoveryChannelId = currentVoiceChannelIdRef.current;

							if (!isMissingVoiceSessionError(error) || recoveryChannelId === undefined) {
								throw error;
							}

							logVoice('Voice session missing during transport recovery, attempting fresh voice join', {
								channelId: recoveryChannelId,
								error,
							});

							recoveryJoinResult = await withRecoveryTimeout(
								rejoinVoiceSession(recoveryChannelId, {
									isCurrent: isCurrentAttempt,
									signal: context.signal,
								}),
							);
							if (restartIfNonceChanged()) return;

							device = recoveryJoinResult.device;
							currentRtpCapabilities = device.rtpCapabilities;
							deviceRef.current = device;
							routerRtpCapabilities.current = recoveryJoinResult.routerRtpCapabilities;
							sendRtpCapabilities.current = device.rtpCapabilities;
							const store = useServerStore.getState();
							store.setCurrentVoiceChannelId(recoveryChannelId);
							store.reconcileVoiceChannelUsers({
								channelId: recoveryChannelId,
								users: recoveryJoinResult.channelUsers,
							});

							await withRecoveryTimeout(
								Promise.all([
									createProducerTransport(device, recoveryJoinResult.producerTransportParams, isCurrentAttempt),
									createConsumerTransport(device, recoveryJoinResult.consumerTransportParams, isCurrentAttempt),
								]),
							);
						}

						if (restartIfNonceChanged()) return;

						sendRtpCapabilities.current = currentRtpCapabilities;
						setVoiceEventRtpCapabilities(currentRtpCapabilities);

						const republishTasks: Promise<void>[] = [];

						const currentAudioStream = localAudioStreamRef.current;
						const currentAudioTrack = currentAudioStream?.getAudioTracks()[0];
						republishTasks.push(
							recoverTransportMicrophone(
								{
									recoveryJoined: recoveryJoinResult !== undefined,
									micMuted: ownVoiceStateSelector(useServerStore.getState()).micMuted,
									canSpeak: canSpeakRef.current,
									hasCurrentStream: currentAudioStream !== undefined,
									currentTrackLive: currentAudioTrack?.readyState === 'live',
								},
								{
									start: () => microphone.start(isCurrentAttempt),
									publishCurrent: () => microphone.publish('current', isCurrentAttempt),
									onStartFailed: (error) => {
										logVoice('Microphone restart failed during transport recovery; continuing muted', { error });
										void commitTerminalMicMutedRef.current?.();
									},
								},
							).then((result) => {
								if (result === 'superseded') {
									throw new VoiceSessionExecutionSupersededError();
								}
							}),
						);

						const localMediaRepublishPlan = buildLocalMediaRepublishPlan(isCurrentAttempt);
						republishTasks.push(...localMediaRepublishPlan.tasks);

						await withRecoveryTimeout(
							Promise.all([
								consumeExistingProducers(currentRtpCapabilities, undefined, recoveryJoinResult?.existingProducers),
								...republishTasks,
							]),
						);
						if (restartIfNonceChanged()) return;

						await withRecoveryTimeout(
							syncRepublishedLocalMediaState(localMediaRepublishPlan.state, {
								isCurrent: isCurrentAttempt,
								signal: context.signal,
							}),
						);
						if (restartIfNonceChanged()) return;

						if (recoveryJoinResult) {
							logVoice('Refreshing existing producers after voice session rejoin');
							await withRecoveryTimeout(consumeExistingProducers(currentRtpCapabilities));
							if (restartIfNonceChanged()) return;

							await withRecoveryTimeout(
								new Promise<void>((resolve) => {
									setTimeout(resolve, RECOVERY_POST_REJOIN_PRODUCER_REFRESH_DELAY_MS);
								}),
							);
							if (restartIfNonceChanged()) return;

							logVoice('Refreshing existing producers after delayed voice session rejoin sync');
							await withRecoveryTimeout(consumeExistingProducers(currentRtpCapabilities));
						}

						if (restartIfNonceChanged()) return;

						if (recoveryJoinResult) {
							useServerStore.getState().bumpVoiceSessionReconnectNonce();
						}

						startMonitoring(producerTransport.current, consumerTransport.current);
						logVoice('Voice transport recovery completed successfully');
					} catch (error) {
						logVoice('Voice transport recovery attempt failed', {
							attempt: command.attempt + 1,
							error,
						});
						throw error;
					}
				},
			);
		},
		[
			clearExternalStreams,
			clearRemoteUserStreams,
			cleanupTransports,
			consumeExistingProducers,
			buildLocalMediaRepublishPlan,
			createConsumerTransport,
			createProducerTransport,
			ensureVoiceDeviceLoaded,
			producerTransport,
			consumerTransport,
			microphone,
			rehydrateWatchIntentOnly,
			resetStats,
			rejoinVoiceSession,
			startMonitoring,
			stopMonitoring,
			syncRepublishedLocalMediaState,
		],
	);

	const restoreVoiceSession = useCallback(
		async (
			command: Extract<TVoiceSessionCommand, { type: 'RestoreVoiceSession' }>,
			context: TVoiceSessionRestoreContext,
		): Promise<{ serverSessionEstablished: boolean }> => {
			const reconnectAttemptId = createReconnectAttemptId();
			const attemptNumber = command.attempt + 1;

			logDebug('Voice reconnect attempt start', {
				attempt: attemptNumber,
				channelId: command.pending.channelId,
				reconnectAttemptId,
			});

			try {
				const bootstrap = await context.withTimeout(
					requestVoiceRestoreOrJoin({
						channelId: command.pending.channelId,
						micMuted: command.pending.micMuted,
						soundMuted: command.pending.soundMuted,
						reconnectAttemptId,
						signal: context.signal,
					}),
				);
				context.markServerSessionEstablished();
				if (!context.isCurrent()) {
					throw new VoiceSessionExecutionSupersededError();
				}

				const initResult = await context.withTimeout(
					init(bootstrap.routerRtpCapabilities, command.pending.channelId, {
						producerTransportParams: bootstrap.producerTransportParams,
						consumerTransportParams: bootstrap.consumerTransportParams,
						existingProducers: bootstrap.existingProducers,
						preserveLocalMedia: true,
						restoreWatchSnapshot: command.snapshot,
						isCurrentRecovery: context.isCurrent,
					}),
				);
				if (!context.isCurrent()) {
					throw new VoiceSessionExecutionSupersededError();
				}

				const serverStore = useServerStore.getState();
				serverStore.setCurrentVoiceChannelId(command.pending.channelId);
				if (!context.isCurrent()) {
					throw new VoiceSessionExecutionSupersededError();
				}
				serverStore.reconcileVoiceChannelUsers({
					channelId: command.pending.channelId,
					users: bootstrap.channelUsers,
				});
				if (!context.isCurrent()) {
					throw new VoiceSessionExecutionSupersededError();
				}
				serverStore.bumpVoiceSessionReconnectNonce();

				await context.withTimeout(
					syncRepublishedLocalMediaState(initResult.republishedLocalMediaState, {
						isCurrent: context.isCurrent,
						signal: context.signal,
					}),
				);
				if (!context.isCurrent()) {
					throw new VoiceSessionExecutionSupersededError();
				}

				return { serverSessionEstablished: true };
			} catch (error) {
				logDebug('Voice reconnect restore attempt failed', {
					attempt: attemptNumber,
					error,
				});
				throw error;
			}
		},
		[init, requestVoiceRestoreOrJoin, syncRepublishedLocalMediaState],
	);

	const clearFailedVoiceSession = useCallback(
		async (command: Extract<TVoiceSessionCommand, { type: 'ClearFailedSession' }>): Promise<void> => {
			// restoreOrJoin already bound a server-side session this cycle; without an
			// explicit leave the runtime would keep us resident in the channel even
			// though the client is giving up.
			const leaveRequest = command.leaveServerSession ? requestRecoveryFailureLeave() : undefined;

			clearOwnVoiceSessionAfterReconnectFailure(command.reason);
			voiceCleanupRef.current?.();

			await leaveRequest;
		},
		[requestRecoveryFailureLeave],
	);

	useVoiceSessionExecutor({
		commandObserver: voiceSessionCommandObserver,
		now: Date.now,
		random: Math.random,
		delay: delayVoiceSessionCommand,
		isOnline: isVoiceReconnectOnline,
		captureRecoverySnapshot: captureWatchedRemoteStreams,
		rebuildTransports,
		restoreVoiceSession,
		restoreWatchIntent: rehydrateWatchIntentOnly,
		recoverDesktopAppAudio: async () => {
			const recovery = shareAudio.recover();
			await recovery;
		},
		onRebuildSucceeded: (transition) => {
			transportRecoveryCircuitRef.current = recordTransportRecoverySucceeded({
				state: transportRecoveryCircuitRef.current,
				transition,
			});
			hasHandledTransportFailureRef.current = false;
		},
		onReconnectSucceeded: (transition) => {
			transportRecoveryCircuitRef.current = recordTransportRecoverySucceeded({
				state: transportRecoveryCircuitRef.current,
				transition,
			});
			hasHandledTransportFailureRef.current = false;
		},
		leaveVoiceSession: leaveAfterFailedTransportRecovery,
		clearFailedSession: clearFailedVoiceSession,
		reportCommandError: (command, error) => {
			// A command that raced the socket going down is expected fallout of the
			// disconnect, not a command defect. The reconnect machinery already
			// reports when recovery actually gives up, so filing this too just
			// duplicates every drop under a misleading title.
			if (error instanceof TRPCClientUnavailableError) {
				logVoice('Voice session command skipped: server connection unavailable', {
					commandType: command.type,
					commandId: command.commandId,
					generation: command.generation,
				});
				return;
			}

			reportError('Voice session command failed', error, {
				commandType: command.type,
				commandId: command.commandId,
				generation: command.generation,
			});
		},
		reportRebuildDetached: (command) => {
			reportError('Voice transport rebuild detached a hung cancelled operation', new Error('Voice rebuild detached'), {
				commandType: command.type,
				commandId: command.commandId,
				generation: command.generation,
				phase: 'rebuilding',
				attempt: command.attempt + 1,
			});
		},
		reportRebuildTerminalFailure: (command, error) => {
			reportError('Voice transport recovery failed', error, {
				commandType: command.type,
				commandId: command.commandId,
				generation: command.generation,
				phase: 'rebuilding',
				attempt: command.attempt + 1,
			});
		},
		reportRestoreDetached: (command) => {
			reportError('Voice reconnect detached a hung cancelled operation', new Error('Voice restore detached'), {
				commandType: command.type,
				commandId: command.commandId,
				generation: command.generation,
				phase: 'restoring',
				attempt: command.attempt + 1,
			});
		},
	});

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
	});

	commitTerminalMicMutedRef.current = commitTerminalMicMuted;
	const canSpeakRef = useLatestRef(channelCan(ChannelPermission.SPEAK));

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

	useEffect(() => {
		return () => {
			logVoice('Voice provider unmounting, cleaning up resources');
			voiceCleanupRef.current?.();
		};
	}, []);

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
