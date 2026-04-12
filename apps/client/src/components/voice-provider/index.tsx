import {
	ChannelPermission,
	StreamKind,
	type TExternalStream,
	type TRemoteProducerIds,
	type TTransportParams,
	type TVoiceUserState,
} from '@sharkord/shared';
import { Device } from 'mediasoup-client';
import type { AppData, Producer, RtpCapabilities, RtpCodecCapability } from 'mediasoup-client/types';
import { createContext, type MutableRefObject, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { requestScreenShareSelection as requestScreenShareSelectionDialog } from '@/features/dialogs/actions';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { channelByIdSelector } from '@/features/server/channels/selectors';
import { useChannelCan, useIsConnected } from '@/features/server/hooks';
import { useServerStore } from '@/features/server/slice';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { updateOwnVoiceState } from '@/features/server/voice/actions';
import { useConfirmedOwnVoiceState, useOwnVoiceState } from '@/features/server/voice/hooks';
import { ownVoiceStateSelector } from '@/features/server/voice/selectors';
import { logVoice } from '@/helpers/browser-logger';
import { getResWidthHeight } from '@/helpers/get-res-with-height';
import { getTrpcErrorData, isNonRetriableTrpcError } from '@/helpers/trpc-error-data';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { normalizeDesktopCapabilities } from '@/runtime/desktop-capabilities';
import {
	ScreenAudioMode,
	type TAppAudioSession,
	type TAppAudioStatusEvent,
	type TDesktopCapabilities,
	type TDesktopScreenShareSelection,
	type TStartAppAudioCaptureInput,
} from '@/runtime/types';
import { type TDeviceSettings, type TRemoteUserStreamKinds, VideoCodecPreference } from '@/types';
import { useDevices } from '../devices-provider/hooks/use-devices';
import { createAudioContextWithSampleRateFallback, resolveAudioContextClass } from './audio-context';
import { createDesktopAppAudioPipeline, type TDesktopAppAudioPipeline } from './desktop-app-audio';
import { FloatingPinnedCard } from './floating-pinned-card';
import { useLocalStreams } from './hooks/use-local-streams';
import { getPendingStreamKey, usePendingStreams } from './hooks/use-pending-streams';
import { useRemoteStreams } from './hooks/use-remote-streams';
import { type TransportStatsData, useTransportStats } from './hooks/use-transport-stats';
import { useTransports } from './hooks/use-transports';
import { useVoiceControls } from './hooks/use-voice-controls';
import { useVoiceEvents } from './hooks/use-voice-events';
import { createMicAudioProcessingPipeline, type TMicAudioProcessingPipeline } from './mic-audio-processing';
import { getVideoBitratePolicy } from './video-bitrate-policy';
import { createVoiceActivityStore, startVoiceActivityMonitor, type VoiceActivityStore } from './voice-activity';
import { VolumeControlProvider } from './volume-control-provider';
import type { TVolumeSettingsUpdatedDetail } from './volume-control-storage';
import { getStoredVolume, OWN_MIC_VOLUME_KEY, VOLUME_SETTINGS_UPDATED_EVENT } from './volume-control-storage';

type AudioVideoRefs = {
	videoRef: React.RefObject<HTMLVideoElement | null>;
	audioRef: React.RefObject<HTMLAudioElement | null>;
	screenShareRef: React.RefObject<HTMLVideoElement | null>;
	screenShareAudioRef: React.RefObject<HTMLAudioElement | null>;
	externalAudioRef: React.RefObject<HTMLAudioElement | null>;
	externalVideoRef: React.RefObject<HTMLVideoElement | null>;
};

type TPreparedMicPipeline = {
	outboundStream: MediaStream;
	outboundAudioTrack: MediaStreamTrack;
};

type TScreenShareStreamHandlers = {
	onVideoTrackStarted?: () => void;
	onVideoTrackEnded?: () => void | Promise<void>;
};

type TWatchedRemoteStreamsSnapshot = {
	remoteUserStreams: Record<number, TRemoteUserStreamKinds[]>;
	externalStreams: Record<number, TTrackedExternalWatchState>;
};

type TRecoveryJoinResult = {
	device: Device;
	existingProducers?: TRemoteProducerIds;
	producerTransportParams?: TTransportParams;
	consumerTransportParams?: TTransportParams;
};

export type { AudioVideoRefs };

enum ConnectionStatus {
	DISCONNECTED = 'disconnected',
	CONNECTING = 'connecting',
	CONNECTED = 'connected',
	FAILED = 'failed',
}

const VIDEO_CODEC_MIME_TYPE_BY_PREFERENCE: Record<string, string> = {
	[VideoCodecPreference.VP8]: 'video/VP8',
	[VideoCodecPreference.H264]: 'video/H264',
	[VideoCodecPreference.AV1]: 'video/AV1',
};
const DEFAULT_AUDIO_OPUS_TARGET_BITRATE_BPS = 96_000;

type ResolvedMicProcessingConfig = {
	wasmNoiseSuppressionEnabled: boolean;
	browserAutoGainControl: boolean;
	browserNoiseSuppression: boolean;
	browserEchoCancellation: boolean;
};

const resolvePreferredVideoCodec = (
	rtpCapabilities: RtpCapabilities | null,
	preference: VideoCodecPreference,
): RtpCodecCapability | undefined => {
	if (!rtpCapabilities || preference === VideoCodecPreference.AUTO) {
		return undefined;
	}

	const preferredMimeType = VIDEO_CODEC_MIME_TYPE_BY_PREFERENCE[preference]?.toLowerCase();

	if (!preferredMimeType) {
		return undefined;
	}

	return (rtpCapabilities.codecs ?? []).find((codec) => {
		return codec.mimeType.toLowerCase() === preferredMimeType;
	});
};

const resolveMicProcessingConfig = (devices: TDeviceSettings): ResolvedMicProcessingConfig => {
	const browserWasmNoiseSuppressionEnabled = devices.wasmNoiseSuppressionEnabled && devices.noiseSuppression;
	return {
		wasmNoiseSuppressionEnabled: browserWasmNoiseSuppressionEnabled,
		browserAutoGainControl: devices.autoGainControl,
		browserNoiseSuppression: browserWasmNoiseSuppressionEnabled ? false : devices.noiseSuppression,
		browserEchoCancellation: devices.echoCancellation,
	};
};

const didMicCaptureSettingsChange = (previousDevices: TDeviceSettings, nextDevices: TDeviceSettings) => {
	return (
		previousDevices.microphoneId !== nextDevices.microphoneId ||
		previousDevices.echoCancellation !== nextDevices.echoCancellation ||
		previousDevices.noiseSuppression !== nextDevices.noiseSuppression ||
		previousDevices.wasmNoiseSuppressionEnabled !== nextDevices.wasmNoiseSuppressionEnabled ||
		previousDevices.autoGainControl !== nextDevices.autoGainControl
	);
};

const didWebcamCaptureSettingsChange = (previousDevices: TDeviceSettings, nextDevices: TDeviceSettings) => {
	return (
		previousDevices.webcamId !== nextDevices.webcamId ||
		previousDevices.webcamResolution !== nextDevices.webcamResolution ||
		previousDevices.webcamFramerate !== nextDevices.webcamFramerate ||
		previousDevices.videoCodec !== nextDevices.videoCodec
	);
};

type TMicGainPipeline = {
	audioContext: AudioContext;
	gainNode: GainNode;
	track: MediaStreamTrack;
	stream: MediaStream;
	destroy: () => Promise<void>;
};

const clampVolumePercent = (value: number) => {
	return Math.min(100, Math.max(0, value));
};

const shouldUseMicGainPipeline = (volume: number) => {
	return clampVolumePercent(volume) !== 100;
};

type TTrackedExternalWatchState = {
	audio: boolean;
	video: boolean;
};

type TChannelExternalStreams = {
	[streamId: number]: TExternalStream;
};

type VoiceActivityMonitorStop = () => void;

const EMPTY_CHANNEL_EXTERNAL_STREAMS: TChannelExternalStreams = {};

const isExternalStreamKind = (kind: StreamKind): kind is StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO => {
	return kind === StreamKind.EXTERNAL_AUDIO || kind === StreamKind.EXTERNAL_VIDEO;
};

const getExternalStreamWatchIdentity = (stream: Pick<TExternalStream, 'pluginId' | 'key'>) => {
	return `${stream.pluginId}:${stream.key}`;
};

const getTrackedExternalWatchField = (
	kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO,
): keyof TTrackedExternalWatchState => {
	return kind === StreamKind.EXTERNAL_AUDIO ? 'audio' : 'video';
};

const getAudioOpusConfig = (channelId: number | undefined) => {
	let bitrate = DEFAULT_AUDIO_OPUS_TARGET_BITRATE_BPS;
	let dtx = false;

	if (channelId !== undefined) {
		const channel = channelByIdSelector(useServerStore.getState(), channelId);

		if (channel?.voiceBitrate != null) {
			bitrate = channel.voiceBitrate;
		}

		if (channel?.voiceDtx != null) {
			dtx = channel.voiceDtx;
		}
	}

	return {
		maxBitrate: bitrate,
		codecOptions: {
			opusMaxAverageBitrate: bitrate,
			opusDtx: dtx,
		},
	};
};

const getDesktopAudioIssueToastMessage = (
	capabilities: TDesktopCapabilities | undefined,
	audioMode: ScreenAudioMode,
) => {
	const affectedFeature = audioMode === ScreenAudioMode.SYSTEM ? 'system-audio' : 'per-app-audio';
	const relevantIssue =
		capabilities?.issues.find((issue) => {
			return issue.affects.includes(affectedFeature) && issue.severity === 'error';
		}) ??
		capabilities?.issues.find((issue) => {
			return issue.affects.includes(affectedFeature) && issue.severity === 'warning';
		});

	if (!relevantIssue) {
		return undefined;
	}

	return relevantIssue.guidance[0]
		? `${relevantIssue.title}: ${relevantIssue.guidance[0]}`
		: `${relevantIssue.title}: ${relevantIssue.message}`;
};

const createMicGainPipeline = async (
	inputStream: MediaStream,
	volume: number,
): Promise<TMicGainPipeline | undefined> => {
	const inputTrack = inputStream.getAudioTracks()[0];

	if (!inputTrack) {
		return undefined;
	}

	const AudioContextClass = resolveAudioContextClass();

	if (!AudioContextClass) {
		return undefined;
	}

	const audioContext = createAudioContextWithSampleRateFallback({
		AudioContextClass,
		sampleRate: 48_000,
		onPreferredSampleRateError: (preferredSampleRateError) => {
			logVoice('Falling back to a browser-default AudioContext for microphone gain processing', {
				preferredSampleRateError,
			});
		},
		onFallbackError: (fallbackError) => {
			logVoice('Failed to create an AudioContext for microphone gain processing', {
				fallbackError,
			});
		},
	});

	if (!audioContext) {
		return undefined;
	}

	try {
		if (audioContext.state === 'suspended') {
			await audioContext.resume();
		}
	} catch {
		// ignore resume failures and continue with the browser-managed state
	}

	const sourceNode = audioContext.createMediaStreamSource(new MediaStream([inputTrack]));
	const gainNode = audioContext.createGain();
	const destinationNode = audioContext.createMediaStreamDestination();
	const outputTrack = destinationNode.stream.getAudioTracks()[0];

	if (!outputTrack) {
		await audioContext.close().catch(() => {
			// ignore close failures
		});
		return undefined;
	}

	gainNode.gain.value = clampVolumePercent(volume) / 100;
	sourceNode.connect(gainNode);
	gainNode.connect(destinationNode);

	const handleInputEnded = () => {
		outputTrack.stop();
	};

	inputTrack.addEventListener('ended', handleInputEnded);

	return {
		audioContext,
		gainNode,
		track: outputTrack,
		stream: destinationNode.stream,
		destroy: async () => {
			inputTrack.removeEventListener('ended', handleInputEnded);

			try {
				sourceNode.disconnect();
			} catch {
				// ignore disconnect failures
			}

			try {
				gainNode.disconnect();
			} catch {
				// ignore disconnect failures
			}

			try {
				destinationNode.disconnect();
			} catch {
				// ignore disconnect failures
			}

			await audioContext.close().catch(() => {
				// ignore close failures
			});
		},
	};
};

export type TVoiceProvider = {
	loading: boolean;
	connectionStatus: ConnectionStatus;
	transportStats: TransportStatsData;
	audioVideoRefsMap: Map<number, AudioVideoRefs>;
	ownVoiceState: TVoiceUserState;
	getOrCreateRefs: (remoteId: number) => AudioVideoRefs;
	acceptStream: (remoteId: number, kind: StreamKind) => void;
	stopWatchingStream: (remoteId: number, kind: StreamKind) => void;
	init: (
		routerRtpCapabilities: RtpCapabilities,
		channelId: number,
		opts?: {
			producerTransportParams?: TTransportParams;
			consumerTransportParams?: TTransportParams;
			existingProducers?: TRemoteProducerIds;
			playJoinSound?: boolean;
		},
	) => Promise<void>;
} & Pick<
	ReturnType<typeof useLocalStreams>,
	'localAudioStream' | 'localVideoStream' | 'localScreenShareStream' | 'localScreenShareAudioStream'
> &
	Pick<ReturnType<typeof useRemoteStreams>, 'remoteUserStreams' | 'externalStreams'> &
	Pick<ReturnType<typeof usePendingStreams>, 'pendingStreams'> &
	ReturnType<typeof useVoiceControls>;

const VoiceProviderContext = createContext<TVoiceProvider>({
	loading: false,
	connectionStatus: ConnectionStatus.DISCONNECTED,
	transportStats: {
		producer: null,
		consumer: null,
		totalBytesReceived: 0,
		totalBytesSent: 0,
		isMonitoring: false,
		currentBitrateReceived: 0,
		currentBitrateSent: 0,
		averageBitrateReceived: 0,
		averageBitrateSent: 0,
	},
	audioVideoRefsMap: new Map(),
	getOrCreateRefs: () => ({
		videoRef: { current: null },
		audioRef: { current: null },
		screenShareRef: { current: null },
		screenShareAudioRef: { current: null },
		externalAudioRef: { current: null },
		externalVideoRef: { current: null },
	}),
	acceptStream: () => undefined,
	stopWatchingStream: () => undefined,
	init: () => Promise.resolve(),
	isStartingScreenShare: false,
	setMicMuted: () => Promise.resolve(),
	toggleMic: () => Promise.resolve(),
	toggleSound: () => Promise.resolve(),
	toggleWebcam: () => Promise.resolve(),
	toggleScreenShare: () => Promise.resolve(),
	ownVoiceState: {
		micMuted: false,
		soundMuted: false,
		webcamEnabled: false,
		sharingScreen: false,
	},
	localAudioStream: undefined,
	localVideoStream: undefined,
	localScreenShareStream: undefined,
	localScreenShareAudioStream: undefined,

	remoteUserStreams: {},
	externalStreams: {},
	pendingStreams: new Map(),
});

const VoiceActivityContext = createContext<VoiceActivityStore | null>(null);

type TVoiceProviderProps = {
	children: React.ReactNode;
};

const RECOVERY_MAX_ATTEMPTS = 3;
const RECOVERY_MAX_NONCE_RESTARTS = 5;
const RECOVERY_TIMEOUT_MS = 12_000;
const RECOVERY_BACKOFF_MS = [1_000, 2_000] as const;

class VoiceSessionReconnectChangedError extends Error {
	constructor(stage: string) {
		super(`Voice session changed during transport recovery (${stage})`);
		this.name = 'VoiceSessionReconnectChangedError';
	}
}

const withRecoveryTimeout = <T,>(promise: Promise<T>): Promise<T> => {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		handle = setTimeout(() => reject(new Error('Voice transport recovery timed out')), RECOVERY_TIMEOUT_MS);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (handle !== undefined) {
			clearTimeout(handle);
		}
	});
};

const isMissingVoiceSessionError = (error: unknown): boolean => getTrpcErrorData(error)?.code === 'BAD_REQUEST';

const VoiceProvider = memo(({ children }: TVoiceProviderProps) => {
	const [loading, setLoading] = useState(false);
	const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
	const [ownVoiceActivityStream, setOwnVoiceActivityStream] = useState<MediaStream | undefined>(undefined);
	const [voiceEventRtpCapabilities, setVoiceEventRtpCapabilities] = useState<RtpCapabilities | null>(null);
	const deviceRef = useRef<Device | undefined>(undefined);
	const routerRtpCapabilities = useRef<RtpCapabilities | null>(null);
	const sendRtpCapabilities = useRef<RtpCapabilities | null>(null);
	const audioVideoRefsMap = useRef<Map<number, AudioVideoRefs>>(new Map());
	const ownVoiceState = useOwnVoiceState();
	const ownUserId = useOwnUserId();
	const ownConfirmedVoiceState = useConfirmedOwnVoiceState();
	const confirmedOwnMicMuted = ownConfirmedVoiceState?.micMuted;
	const currentVoiceChannelId = useCurrentVoiceChannelId();
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
	const appAudioPipelineRef = useRef<TDesktopAppAudioPipeline | undefined>(undefined);
	const appAudioSessionRef = useRef<TAppAudioSession | undefined>(undefined);
	const removeAppAudioFrameSubscriptionRef = useRef<(() => void) | undefined>(undefined);
	const removeAppAudioStatusSubscriptionRef = useRef<(() => void) | undefined>(undefined);
	const appAudioStartupTimeoutRef = useRef<number | ReturnType<typeof setTimeout> | undefined>(undefined);
	const rawMicStreamRef = useRef<MediaStream | undefined>(undefined);
	const micAudioPipelineRef = useRef<TMicAudioProcessingPipeline | undefined>(undefined);
	const micGainPipelineRef = useRef<TMicGainPipeline | undefined>(undefined);
	const standbyDisplayAudioTrackRef = useRef<MediaStreamTrack | undefined>(undefined);
	const standbyDisplayAudioStreamRef = useRef<MediaStream | undefined>(undefined);
	const isPushToTalkHeldRef = useRef(false);
	const isPushToMuteHeldRef = useRef(false);
	const micMutedBeforePushRef = useRef<boolean | undefined>(undefined);
	const previousDevicesRef = useRef<TDeviceSettings | undefined>(undefined);
	const watchedExternalStreamsRef = useRef<Record<string, TTrackedExternalWatchState>>({});
	const voiceActivityStoreRef = useRef(createVoiceActivityStore());
	const voiceActivityStreamsRef = useRef<Map<number, MediaStream>>(new Map());
	const voiceActivityCleanupRef = useRef<Map<number, VoiceActivityMonitorStop>>(new Map());
	const micVolumeRestartPromiseRef = useRef<Promise<void> | undefined>(undefined);
	const startMicStreamRef = useRef<(() => Promise<void>) | undefined>(undefined);
	const localAudioStreamRef = useRef<MediaStream | undefined>(undefined);
	const localVideoStreamRef = useRef<MediaStream | undefined>(undefined);
	const localScreenShareStreamRef = useRef<MediaStream | undefined>(undefined);
	const localScreenShareAudioStreamRef = useRef<MediaStream | undefined>(undefined);
	const transportRecoveryPromiseRef = useRef<Promise<boolean> | undefined>(undefined);
	const recoverTransportSessionRef = useRef<(() => Promise<boolean>) | undefined>(undefined);
	const cleanupMicAudioPipelineRef = useRef<(() => Promise<void>) | undefined>(undefined);
	const cleanupDesktopAppAudioRef = useRef<
		((options?: { stopCapture?: boolean; preserveCurrentAudio?: boolean }) => Promise<void>) | undefined
	>(undefined);

	const getOrCreateRefs = useCallback((remoteId: number): AudioVideoRefs => {
		if (!audioVideoRefsMap.current.has(remoteId)) {
			audioVideoRefsMap.current.set(remoteId, {
				videoRef: { current: null },
				audioRef: { current: null },
				screenShareRef: { current: null },
				screenShareAudioRef: { current: null },
				externalAudioRef: { current: null },
				externalVideoRef: { current: null },
			});
		}

		return audioVideoRefsMap.current.get(remoteId)!;
	}, []);

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
	const remoteUserStreamsRef = useRef(remoteUserStreams);
	const externalStreamsRef = useRef(externalStreams);
	const { pendingStreams, addPendingStream, removePendingStream, clearPendingStreamsForUser, clearAllPendingStreams } =
		usePendingStreams();

	const {
		localAudioProducer,
		localVideoProducer,
		localAudioStream,
		localVideoStream,
		localScreenShareStream,
		localScreenShareAudioStream,
		localScreenShareProducer,
		localScreenShareAudioProducer,
		setLocalAudioStream,
		setLocalVideoStream,
		setLocalScreenShare,
		setLocalScreenShareAudio,
		clearLocalStreams,
	} = useLocalStreams();

	useEffect(() => {
		localAudioStreamRef.current = localAudioStream;
	}, [localAudioStream]);

	useEffect(() => {
		localVideoStreamRef.current = localVideoStream;
	}, [localVideoStream]);

	useEffect(() => {
		localScreenShareStreamRef.current = localScreenShareStream;
	}, [localScreenShareStream]);

	useEffect(() => {
		localScreenShareAudioStreamRef.current = localScreenShareAudioStream;
	}, [localScreenShareAudioStream]);

	useEffect(() => {
		remoteUserStreamsRef.current = remoteUserStreams;
	}, [remoteUserStreams]);

	useEffect(() => {
		externalStreamsRef.current = externalStreams;
	}, [externalStreams]);

	const voiceCleanupRef = useRef<(() => void) | undefined>(undefined);
	const hasHandledTransportFailureRef = useRef(false);
	const currentVoiceChannelIdRef = useRef(currentVoiceChannelId);
	const isConnectedRef = useRef(isConnected);
	const voiceSessionReconnectNonceRef = useRef(voiceSessionReconnectNonce);

	const onTransportFailure = useCallback(() => {
		if (hasHandledTransportFailureRef.current) {
			logVoice('Transport failure already handled, skipping duplicate cleanup');
			return;
		}

		hasHandledTransportFailureRef.current = true;
		logVoice('Transport failure detected');

		void (async () => {
			const recovered = await recoverTransportSessionRef.current?.();

			if (recovered) {
				hasHandledTransportFailureRef.current = false;
				return;
			}

			if (isConnectedRef.current && currentVoiceChannelIdRef.current !== undefined) {
				// Tell the server to remove us from the voice channel so other
				// participants don't see a ghost user stuck in the channel.
				// Fire-and-forget: even if this fails, we still clean up locally.
				getTRPCClient()
					.voice.leave.mutate()
					.catch((error) => {
						logVoice('Failed to send voice.leave after unrecoverable transport failure', { error });
					});

				useServerStore.getState().setCurrentVoiceChannelId(undefined);
				useServerStore.getState().updateOwnVoiceState({
					webcamEnabled: false,
					sharingScreen: false,
				});
				useServerStore.getState().setPinnedCard(undefined);
				playSound(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
				toast.info('Voice connection was lost. Rejoin the voice channel manually.');
			}

			hasHandledTransportFailureRef.current = false;
			voiceCleanupRef.current?.();
		})();
	}, []);

	const {
		producerTransport,
		consumerTransport,
		createProducerTransport,
		createConsumerTransport,
		consume,
		consumeExistingProducers,
		stopWatchingStream: stopWatchingConsumedStream,
		cleanupTransports,
	} = useTransports({
		addExternalStreamTrack,
		removeExternalStreamTrack,
		addRemoteUserStream,
		removeRemoteUserStream,
		addPendingStream,
		removePendingStream,
		clearAllPendingStreams,
		onTransportFailure,
	});

	const captureWatchedRemoteStreams = useCallback((): TWatchedRemoteStreamsSnapshot => {
		const watchedRemoteStreams: Record<number, TRemoteUserStreamKinds[]> = {};
		const watchedExternalStreams: Record<number, TTrackedExternalWatchState> = {};

		Object.entries(remoteUserStreamsRef.current).forEach(([userId, streams]) => {
			const watchedKinds: TRemoteUserStreamKinds[] = [];

			if (streams[StreamKind.VIDEO]) {
				watchedKinds.push(StreamKind.VIDEO);
			}

			if (streams[StreamKind.SCREEN]) {
				watchedKinds.push(StreamKind.SCREEN);
			}

			if (streams[StreamKind.SCREEN_AUDIO]) {
				watchedKinds.push(StreamKind.SCREEN_AUDIO);
			}

			if (watchedKinds.length > 0) {
				watchedRemoteStreams[Number(userId)] = watchedKinds;
			}
		});

		Object.entries(externalStreamsRef.current).forEach(([streamId, stream]) => {
			const watchedState = {
				audio: stream.audioStream !== undefined,
				video: stream.videoStream !== undefined,
			};

			if (watchedState.audio || watchedState.video) {
				watchedExternalStreams[Number(streamId)] = watchedState;
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

	const bindProducerCloseHandler = useCallback(
		({
			producer,
			kind,
			producerRef,
			logLabel,
		}: {
			producer: Producer<AppData>;
			kind: StreamKind;
			producerRef: MutableRefObject<Producer<AppData> | undefined>;
			logLabel: string;
		}) => {
			producer.on('@close', () => {
				logVoice(`${logLabel} producer closed`, {
					producerId: producer.id,
				});

				if (producerRef.current === producer) {
					producerRef.current = undefined;
				}

				void closeProducerOnServer(kind, producer.id);
			});
		},
		[closeProducerOnServer],
	);

	const acceptStream = useCallback(
		(remoteId: number, kind: StreamKind) => {
			if (isExternalStreamKind(kind)) {
				const stream = currentChannelExternalStreams[remoteId];

				if (stream) {
					const identity = getExternalStreamWatchIdentity(stream);
					const field = getTrackedExternalWatchField(kind);
					const trackedState = watchedExternalStreamsRef.current[identity] ?? {
						audio: false,
						video: false,
					};

					watchedExternalStreamsRef.current = {
						...watchedExternalStreamsRef.current,
						[identity]: {
							...trackedState,
							[field]: true,
						},
					};
				}
			}

			const currentRtpCapabilities = sendRtpCapabilities.current;

			if (!currentRtpCapabilities) {
				logVoice('Cannot accept pending stream before voice is initialized', {
					remoteId,
					kind,
				});
				return;
			}

			void consume(remoteId, kind, currentRtpCapabilities);
		},
		[consume, currentChannelExternalStreams],
	);

	const stopWatchingStream = useCallback(
		(remoteId: number, kind: StreamKind) => {
			if (isExternalStreamKind(kind)) {
				const stream = currentChannelExternalStreams[remoteId];

				if (stream) {
					const identity = getExternalStreamWatchIdentity(stream);
					const field = getTrackedExternalWatchField(kind);
					const trackedState = watchedExternalStreamsRef.current[identity];

					if (trackedState) {
						const nextTrackedState = {
							...trackedState,
							[field]: false,
						};

						if (!nextTrackedState.audio && !nextTrackedState.video) {
							const nextTrackedStreams = {
								...watchedExternalStreamsRef.current,
							};

							delete nextTrackedStreams[identity];
							watchedExternalStreamsRef.current = nextTrackedStreams;
						} else {
							watchedExternalStreamsRef.current = {
								...watchedExternalStreamsRef.current,
								[identity]: nextTrackedState,
							};
						}
					}
				}
			}

			void stopWatchingConsumedStream(remoteId, kind);
		},
		[currentChannelExternalStreams, stopWatchingConsumedStream],
	);

	const { stats: transportStats, startMonitoring, stopMonitoring, resetStats } = useTransportStats();

	const stopVoiceActivityMonitoring = useCallback((userId: number) => {
		voiceActivityCleanupRef.current.get(userId)?.();
		voiceActivityCleanupRef.current.delete(userId);
		voiceActivityStreamsRef.current.delete(userId);
		voiceActivityStoreRef.current.clearUserActivity(userId);
	}, []);

	const stopAllVoiceActivityMonitoring = useCallback(() => {
		voiceActivityCleanupRef.current.forEach((stop) => {
			stop();
		});
		voiceActivityCleanupRef.current.clear();
		voiceActivityStreamsRef.current.clear();
		voiceActivityStoreRef.current.clearAll();
	}, []);

	useEffect(() => {
		if (ownVoiceState.soundMuted) {
			stopAllVoiceActivityMonitoring();
			return;
		}

		const nextAudioStreams = new Map<number, MediaStream>();

		if (ownUserId !== undefined && ownVoiceActivityStream) {
			nextAudioStreams.set(ownUserId, ownVoiceActivityStream);
		}

		Object.entries(remoteUserStreams).forEach(([userId, streams]) => {
			const audioStream = streams[StreamKind.AUDIO];

			if (audioStream) {
				nextAudioStreams.set(Number(userId), audioStream);
			}
		});

		Array.from(voiceActivityStreamsRef.current.keys()).forEach((userId) => {
			if (!nextAudioStreams.has(userId)) {
				stopVoiceActivityMonitoring(userId);
			}
		});

		nextAudioStreams.forEach((audioStream, userId) => {
			if (voiceActivityStreamsRef.current.get(userId) === audioStream) {
				return;
			}

			stopVoiceActivityMonitoring(userId);
			voiceActivityStreamsRef.current.set(userId, audioStream);

			const stop = startVoiceActivityMonitor(audioStream, (activity) => {
				voiceActivityStoreRef.current.setUserActivity(userId, activity);
			});

			voiceActivityCleanupRef.current.set(userId, stop);
		});
	}, [
		ownUserId,
		ownVoiceActivityStream,
		ownVoiceState.soundMuted,
		remoteUserStreams,
		stopAllVoiceActivityMonitoring,
		stopVoiceActivityMonitoring,
	]);

	useEffect(() => {
		if (currentVoiceChannelId === undefined) {
			watchedExternalStreamsRef.current = {};
			return;
		}

		const currentRtpCapabilities = voiceEventRtpCapabilities;

		if (!currentRtpCapabilities) {
			return;
		}

		Object.entries(currentChannelExternalStreams).forEach(([streamId, stream]) => {
			const trackedState = watchedExternalStreamsRef.current[getExternalStreamWatchIdentity(stream)];

			if (!trackedState) {
				return;
			}

			const numericStreamId = Number(streamId);

			if (
				trackedState.audio &&
				stream.tracks.audio &&
				pendingStreams.has(`${numericStreamId}-${StreamKind.EXTERNAL_AUDIO}`)
			) {
				void consume(numericStreamId, StreamKind.EXTERNAL_AUDIO, currentRtpCapabilities);
			}

			if (
				trackedState.video &&
				stream.tracks.video &&
				pendingStreams.has(`${numericStreamId}-${StreamKind.EXTERNAL_VIDEO}`)
			) {
				void consume(numericStreamId, StreamKind.EXTERNAL_VIDEO, currentRtpCapabilities);
			}
		});
	}, [consume, currentChannelExternalStreams, currentVoiceChannelId, pendingStreams, voiceEventRtpCapabilities]);

	useEffect(() => {
		Object.entries(currentChannelExternalStreams).forEach(([streamId, stream]) => {
			const numericStreamId = Number(streamId);
			const activeExternalStream = externalStreams[numericStreamId];
			const hasPendingExternalAudio = pendingStreams.has(
				getPendingStreamKey(numericStreamId, StreamKind.EXTERNAL_AUDIO),
			);
			const hasPendingExternalVideo = pendingStreams.has(
				getPendingStreamKey(numericStreamId, StreamKind.EXTERNAL_VIDEO),
			);

			if (stream.tracks.audio && !activeExternalStream?.audioStream && !hasPendingExternalAudio) {
				addPendingStream(numericStreamId, StreamKind.EXTERNAL_AUDIO);
			}

			if (stream.tracks.video && !activeExternalStream?.videoStream && !hasPendingExternalVideo) {
				addPendingStream(numericStreamId, StreamKind.EXTERNAL_VIDEO);
			}
		});
	}, [addPendingStream, currentChannelExternalStreams, externalStreams, pendingStreams]);

	const applyMicGainVolume = useCallback((volume: number) => {
		const micGainPipeline = micGainPipelineRef.current;

		if (!micGainPipeline) {
			return;
		}

		const nextVolume = clampVolumePercent(volume) / 100;
		const currentTime = micGainPipeline.audioContext.currentTime;

		micGainPipeline.gainNode.gain.cancelScheduledValues(currentTime);
		micGainPipeline.gainNode.gain.setValueAtTime(nextVolume, currentTime);
	}, []);

	const ensureVoiceDeviceLoaded = useCallback(async () => {
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

		deviceRef.current = device;
		sendRtpCapabilities.current = device.rtpCapabilities;

		return device;
	}, []);

	const rejoinVoiceSession = useCallback(async (channelId: number): Promise<TRecoveryJoinResult> => {
		const currentOwnVoiceState = ownVoiceStateSelector(useServerStore.getState());
		const {
			routerRtpCapabilities: nextRouterRtpCapabilities,
			producerTransportParams,
			consumerTransportParams,
			existingProducers,
			channelUsers,
		} = await getTRPCClient().voice.join.mutate({
			channelId,
			state: {
				micMuted: currentOwnVoiceState.micMuted,
				soundMuted: currentOwnVoiceState.soundMuted,
			},
		});

		const device = await Device.factory();
		await device.load({
			routerRtpCapabilities: nextRouterRtpCapabilities,
		});

		deviceRef.current = device;
		routerRtpCapabilities.current = nextRouterRtpCapabilities;
		sendRtpCapabilities.current = device.rtpCapabilities;

		const store = useServerStore.getState();

		store.setCurrentVoiceChannelId(channelId);
		store.reconcileVoiceChannelUsers({
			channelId,
			users: channelUsers,
		});

		return {
			device,
			existingProducers,
			producerTransportParams,
			consumerTransportParams,
		};
	}, []);

	useEffect(() => {
		const handleVolumeSettingsUpdated = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const detail: TVolumeSettingsUpdatedDetail = event.detail;

			if (detail.key !== OWN_MIC_VOLUME_KEY) {
				return;
			}

			const nextVolume = clampVolumePercent(detail.volume);
			const hasMicGainPipeline = micGainPipelineRef.current !== undefined;
			const nextShouldUseMicGainPipeline = shouldUseMicGainPipeline(nextVolume);

			if (hasMicGainPipeline !== nextShouldUseMicGainPipeline) {
				if (
					currentVoiceChannelId !== undefined &&
					localAudioStream !== undefined &&
					micVolumeRestartPromiseRef.current === undefined
				) {
					// Crossing the neutral-volume threshold adds or removes the
					// gain graph entirely, so live gain updates are not enough.
					logVoice('Rebuilding microphone pipeline after mic volume crossed neutral threshold', {
						nextVolume,
						hadMicGainPipeline: hasMicGainPipeline,
						nextShouldUseMicGainPipeline,
					});

					micVolumeRestartPromiseRef.current = (async () => {
						try {
							await startMicStreamRef.current?.();
						} catch (error) {
							logVoice('Failed to rebuild microphone pipeline after mic volume change', { error, nextVolume });
							toast.error('Failed to apply microphone volume');
						} finally {
							micVolumeRestartPromiseRef.current = undefined;
						}
					})();
				}

				return;
			}

			applyMicGainVolume(detail.volume);
		};

		window.addEventListener(VOLUME_SETTINGS_UPDATED_EVENT, handleVolumeSettingsUpdated);

		return () => {
			window.removeEventListener(VOLUME_SETTINGS_UPDATED_EVENT, handleVolumeSettingsUpdated);
		};
	}, [applyMicGainVolume, currentVoiceChannelId, localAudioStream]);

	const publishMicTrack = useCallback(
		async (stream: MediaStream, track: MediaStreamTrack) => {
			setLocalAudioStream(stream);
			track.enabled = !ownVoiceStateSelector(useServerStore.getState()).micMuted;

			logVoice('Obtained audio track', { audioTrack: track });

			const audioConfig = getAudioOpusConfig(currentVoiceChannelIdRef.current);
			const audioProducer = await producerTransport.current?.produce({
				track,
				encodings: [{ maxBitrate: audioConfig.maxBitrate }],
				codecOptions: audioConfig.codecOptions,
				appData: { kind: StreamKind.AUDIO },
			});

			if (!audioProducer) {
				throw new Error('Failed to create microphone producer');
			}

			localAudioProducer.current = audioProducer;

			logVoice('Microphone audio producer created', {
				producer: audioProducer,
			});

			bindProducerCloseHandler({
				producer: audioProducer,
				kind: StreamKind.AUDIO,
				producerRef: localAudioProducer,
				logLabel: 'Audio',
			});

			track.onended = () => {
				logVoice('Audio track ended, cleaning up microphone');

				void cleanupMicAudioPipelineRef.current?.();
				audioProducer.close();

				setLocalAudioStream((currentStream) => {
					return currentStream === stream ? undefined : currentStream;
				});
			};
		},
		[bindProducerCloseHandler, localAudioProducer, producerTransport, setLocalAudioStream],
	);

	const publishWebcamTrack = useCallback(
		async (stream: MediaStream, track: MediaStreamTrack) => {
			setLocalVideoStream(stream);

			logVoice('Obtained video track', { videoTrack: track });

			const preferredVideoCodec = resolvePreferredVideoCodec(sendRtpCapabilities.current, devices.videoCodec);

			if (devices.videoCodec !== VideoCodecPreference.AUTO && !preferredVideoCodec) {
				logVoice('Preferred webcam codec unavailable, falling back to auto', {
					preferredCodec: devices.videoCodec,
				});
			}

			const requestedWebcamResolution = getResWidthHeight(devices?.webcamResolution);
			const webcamTrackSettings = track.getSettings();
			const webcamBitratePolicy = getVideoBitratePolicy({
				profile: 'camera',
				width: webcamTrackSettings.width ?? requestedWebcamResolution.width,
				height: webcamTrackSettings.height ?? requestedWebcamResolution.height,
				frameRate: webcamTrackSettings.frameRate ?? devices.webcamFramerate,
				codecMimeType: preferredVideoCodec?.mimeType,
			});

			const videoProducer = await producerTransport.current?.produce({
				track,
				encodings: [{ maxBitrate: webcamBitratePolicy.maxKbps * 1000 }],
				codec: preferredVideoCodec,
				codecOptions: {
					videoGoogleStartBitrate: webcamBitratePolicy.startKbps,
				},
				appData: { kind: StreamKind.VIDEO },
			});

			if (!videoProducer) {
				throw new Error('Failed to create webcam producer');
			}

			localVideoProducer.current = videoProducer;

			logVoice('Webcam video producer created', {
				producer: videoProducer,
			});

			bindProducerCloseHandler({
				producer: videoProducer,
				kind: StreamKind.VIDEO,
				producerRef: localVideoProducer,
				logLabel: 'Video',
			});

			track.onended = () => {
				logVoice('Video track ended, cleaning up webcam');

				stream.getVideoTracks().forEach((currentTrack) => {
					currentTrack.stop();
				});
				videoProducer.close();

				setLocalVideoStream((currentStream) => {
					return currentStream === stream ? undefined : currentStream;
				});

				updateOwnVoiceState({ webcamEnabled: false });

				void (async () => {
					try {
						await getTRPCClient().voice.updateState.mutate({
							webcamEnabled: false,
						});
					} catch (error) {
						logVoice('Error syncing webcam state after native track end', { error });
					}
				})();
			};
		},
		[
			bindProducerCloseHandler,
			devices.videoCodec,
			devices.webcamFramerate,
			devices.webcamResolution,
			localVideoProducer,
			producerTransport,
			setLocalVideoStream,
		],
	);

	const publishScreenShareTrack = useCallback(
		async (
			stream: MediaStream,
			track: MediaStreamTrack,
			options: {
				onTrackEnded?: () => void | Promise<void>;
			} = {},
		) => {
			setLocalScreenShare(stream);

			logVoice('Obtained video track', { videoTrack: track });

			track.contentHint = 'detail';

			const preferredVideoCodec = resolvePreferredVideoCodec(sendRtpCapabilities.current, devices.videoCodec);

			if (devices.videoCodec !== VideoCodecPreference.AUTO && !preferredVideoCodec) {
				logVoice('Preferred screen share codec unavailable, falling back to auto', {
					preferredCodec: devices.videoCodec,
				});
			}

			const requestedScreenResolution = getResWidthHeight(devices?.screenResolution);
			const screenTrackSettings = track.getSettings();
			const screenBitratePolicy = getVideoBitratePolicy({
				profile: 'screen',
				width: screenTrackSettings.width ?? requestedScreenResolution.width,
				height: screenTrackSettings.height ?? requestedScreenResolution.height,
				frameRate: screenTrackSettings.frameRate ?? devices.screenFramerate,
				codecMimeType: preferredVideoCodec?.mimeType,
			});

			const screenShareProducer = await producerTransport.current?.produce({
				track,
				encodings: [{ maxBitrate: screenBitratePolicy.maxKbps * 1000 }],
				codecOptions: {
					videoGoogleStartBitrate: screenBitratePolicy.startKbps,
				},
				codec: preferredVideoCodec,
				appData: { kind: StreamKind.SCREEN },
			});

			if (!screenShareProducer) {
				throw new Error('Failed to create screen share producer');
			}

			localScreenShareProducer.current = screenShareProducer;

			bindProducerCloseHandler({
				producer: screenShareProducer,
				kind: StreamKind.SCREEN,
				producerRef: localScreenShareProducer,
				logLabel: 'Screen share',
			});

			track.onended = () => {
				logVoice('Screen share track ended, cleaning up screen share');

				stream.getTracks().forEach((currentTrack) => {
					currentTrack.stop();
				});
				screenShareProducer.close();
				localScreenShareAudioProducer.current?.close();
				localScreenShareAudioProducer.current = undefined;
				standbyDisplayAudioTrackRef.current = undefined;
				standbyDisplayAudioStreamRef.current = undefined;
				void cleanupDesktopAppAudioRef.current?.();

				setLocalScreenShare(undefined);
				setLocalScreenShareAudio(undefined);
				void options.onTrackEnded?.();
			};
		},
		[
			bindProducerCloseHandler,
			devices.screenFramerate,
			devices.screenResolution,
			devices.videoCodec,
			localScreenShareAudioProducer,
			localScreenShareProducer,
			producerTransport,
			setLocalScreenShare,
			setLocalScreenShareAudio,
		],
	);

	const publishScreenShareAudioTrack = useCallback(
		async (
			stream: MediaStream,
			track: MediaStreamTrack,
			options: {
				onTrackEnded?: () => void | Promise<void>;
			} = {},
		) => {
			setLocalScreenShareAudio(stream);

			const screenAudioProducer = await producerTransport.current?.produce({
				track,
				appData: { kind: StreamKind.SCREEN_AUDIO },
			});

			if (!screenAudioProducer) {
				throw new Error('Failed to create screen share audio producer');
			}

			localScreenShareAudioProducer.current = screenAudioProducer;

			bindProducerCloseHandler({
				producer: screenAudioProducer,
				kind: StreamKind.SCREEN_AUDIO,
				producerRef: localScreenShareAudioProducer,
				logLabel: 'Screen share audio',
			});

			track.onended = () => {
				screenAudioProducer.close();

				if (localScreenShareAudioProducer.current === screenAudioProducer) {
					localScreenShareAudioProducer.current = undefined;
				}

				setLocalScreenShareAudio((currentStream) => {
					return currentStream === stream ? undefined : currentStream;
				});

				void options.onTrackEnded?.();
			};
		},
		[bindProducerCloseHandler, localScreenShareAudioProducer, producerTransport, setLocalScreenShareAudio],
	);

	const cleanupMicAudioPipeline = useCallback(async () => {
		const currentAudioProducer = localAudioProducer.current;
		localAudioProducer.current = undefined;
		currentAudioProducer?.close();

		const micGainPipeline = micGainPipelineRef.current;
		micGainPipelineRef.current = undefined;

		if (micGainPipeline) {
			micGainPipeline.track.onended = null;

			try {
				await micGainPipeline.destroy();
			} catch (error) {
				logVoice('Failed to clean up microphone gain pipeline', {
					error,
				});
			}
		}

		const rawMicStream = rawMicStreamRef.current;
		rawMicStreamRef.current = undefined;
		setOwnVoiceActivityStream(undefined);

		rawMicStream?.getTracks().forEach((track) => {
			track.stop();
		});

		const pipeline = micAudioPipelineRef.current;
		micAudioPipelineRef.current = undefined;

		if (pipeline) {
			try {
				await pipeline.destroy();
			} catch (error) {
				logVoice('Failed to clean up microphone processing pipeline', {
					error,
				});
			}
		}
	}, [localAudioProducer]);
	cleanupMicAudioPipelineRef.current = cleanupMicAudioPipeline;

	// Acquire mic stream and build the processing pipeline (WASM denoise + gain).
	// This has no dependency on the mediasoup device or transports, so it can run
	// concurrently with device.load() and transport creation during voice join.
	const prepareMicPipeline = useCallback(async (): Promise<TPreparedMicPipeline> => {
		await cleanupMicAudioPipeline();
		const micProcessingConfig = resolveMicProcessingConfig(devices);

		const micConstraints = {
			...(devices.microphoneId
				? {
						deviceId: {
							exact: devices.microphoneId,
						},
					}
				: {}),
			autoGainControl: micProcessingConfig.browserAutoGainControl,
			echoCancellation: micProcessingConfig.browserEchoCancellation,
			noiseSuppression: micProcessingConfig.browserNoiseSuppression,
			sampleRate: 48000,
		};

		const stream = await navigator.mediaDevices.getUserMedia({
			audio: micConstraints,
			video: false,
		});

		logVoice('Microphone stream obtained', { stream });

		rawMicStreamRef.current = stream;
		setOwnVoiceActivityStream(stream);

		const rawAudioTrack = stream.getAudioTracks()[0];

		if (!rawAudioTrack) {
			throw new Error('Failed to obtain audio track from microphone');
		}

		let outboundStream = stream;
		let outboundAudioTrack = rawAudioTrack;

		try {
			const micAudioPipeline = await createMicAudioProcessingPipeline({
				inputTrack: rawAudioTrack,
				wasmNoiseSuppressionEnabled: micProcessingConfig.wasmNoiseSuppressionEnabled,
				onWasmError: (error) => {
					logVoice('Browser WASM voice filter runtime error', { error });

					// Don't destroy the pipeline here — closing the AudioContext would
					// end the MediaStreamTrack already handed to the mediasoup producer,
					// causing complete mic silence for all peers with no recovery.
					// The worklet naturally falls back to passing through raw mic input
					// when the worker errors (underrun passthrough), so audio continues
					// to flow unprocessed. The pipeline is cleaned up normally when the
					// user leaves the channel or changes mic settings.
					if (micAudioPipelineRef.current?.backend === 'browser-wasm') {
						toast.error('Noise suppression encountered an error. Audio will continue without noise reduction.');
					}
				},
			});

			if (micAudioPipeline) {
				micAudioPipelineRef.current = micAudioPipeline;
				outboundStream = micAudioPipeline.stream;
				outboundAudioTrack = micAudioPipeline.track;
				logVoice('Microphone voice filter enabled', {
					backend: micAudioPipeline.backend,
				});
			} else {
				micAudioPipelineRef.current = undefined;
			}
		} catch (error) {
			micAudioPipelineRef.current = undefined;
			logVoice('Failed to initialize microphone voice filter, using raw mic', {
				error,
			});
		}

		const micVolume = getStoredVolume(OWN_MIC_VOLUME_KEY);
		// Keep the default 100% path on the original track so users do not pay
		// for an extra Web Audio graph unless they explicitly change mic volume.
		const micGainPipeline = shouldUseMicGainPipeline(micVolume)
			? await createMicGainPipeline(outboundStream, micVolume)
			: undefined;

		if (micGainPipeline) {
			micGainPipelineRef.current = micGainPipeline;
			outboundStream = micGainPipeline.stream;
			outboundAudioTrack = micGainPipeline.track;
			logVoice('Microphone gain pipeline enabled', {
				volume: micVolume,
			});
		} else {
			micGainPipelineRef.current = undefined;
		}

		return { outboundStream, outboundAudioTrack };
	}, [cleanupMicAudioPipeline, devices]);

	// Attach the prepared mic pipeline to the producer transport. Must be called
	// after the producer transport is ready.
	const produceMicTrack = useCallback(
		async (prepared: TPreparedMicPipeline) => {
			const { outboundStream, outboundAudioTrack } = prepared;
			await publishMicTrack(outboundStream, outboundAudioTrack);
		},
		[publishMicTrack],
	);

	const startMicStream = useCallback(async () => {
		try {
			logVoice('Starting microphone stream');
			const prepared = await prepareMicPipeline();
			await produceMicTrack(prepared);
		} catch (error) {
			logVoice('Error starting microphone stream', { error });
			await cleanupMicAudioPipeline();
			setLocalAudioStream(undefined);
		}
	}, [prepareMicPipeline, produceMicTrack, cleanupMicAudioPipeline, setLocalAudioStream]);
	startMicStreamRef.current = startMicStream;

	const startWebcamStream = useCallback(async () => {
		try {
			logVoice('Starting webcam stream');

			const requestedWebcamResolution = getResWidthHeight(devices?.webcamResolution);

			const stream = await navigator.mediaDevices.getUserMedia({
				audio: false,
				video: {
					...(devices?.webcamId
						? {
								deviceId: {
									exact: devices.webcamId,
								},
							}
						: {}),
					frameRate: devices.webcamFramerate,
					...requestedWebcamResolution,
				},
			});

			logVoice('Webcam stream obtained', { stream });

			const videoTrack = stream.getVideoTracks()[0];

			if (videoTrack) {
				await publishWebcamTrack(stream, videoTrack);
			} else {
				throw new Error('Failed to obtain video track from webcam');
			}
		} catch (error) {
			logVoice('Error starting webcam stream', { error });
			throw error;
		}
	}, [devices.webcamFramerate, devices.webcamId, devices.webcamResolution, publishWebcamTrack]);

	const stopWebcamStream = useCallback(() => {
		logVoice('Stopping webcam stream');

		localVideoStream?.getVideoTracks().forEach((track) => {
			logVoice('Stopping video track', { track });

			track.stop();
			localVideoStream.removeTrack(track);
		});

		localVideoProducer.current?.close();
		localVideoProducer.current = undefined;

		setLocalVideoStream(undefined);
	}, [localVideoStream, setLocalVideoStream, localVideoProducer]);

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
				try {
					logVoice('Applying updated microphone settings live');
					await startMicStream();
				} catch (error) {
					logVoice('Failed to apply microphone settings live', { error });
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

	const cleanupDesktopAppAudio = useCallback(
		async ({
			stopCapture = true,
			preserveCurrentAudio = false,
		}: {
			stopCapture?: boolean;
			preserveCurrentAudio?: boolean;
		} = {}) => {
			const desktopBridge = getDesktopBridge();
			const startupTimeout = appAudioStartupTimeoutRef.current;
			if (startupTimeout !== undefined) {
				window.clearTimeout(startupTimeout);
				appAudioStartupTimeoutRef.current = undefined;
			}

			removeAppAudioFrameSubscriptionRef.current?.();
			removeAppAudioFrameSubscriptionRef.current = undefined;

			removeAppAudioStatusSubscriptionRef.current?.();
			removeAppAudioStatusSubscriptionRef.current = undefined;

			const activeSession = appAudioSessionRef.current;
			appAudioSessionRef.current = undefined;

			if (stopCapture && desktopBridge && activeSession?.sessionId) {
				try {
					await desktopBridge.stopAppAudioCapture(activeSession.sessionId);
				} catch (error) {
					logVoice('Failed to stop desktop app audio capture', { error });
				}
			}

			if (appAudioPipelineRef.current) {
				await appAudioPipelineRef.current.destroy();
			}
			appAudioPipelineRef.current = undefined;

			if (!preserveCurrentAudio) {
				setLocalScreenShareAudio(undefined);
			}
		},
		[setLocalScreenShareAudio],
	);
	cleanupDesktopAppAudioRef.current = cleanupDesktopAppAudio;

	const stopScreenShareStream = useCallback(() => {
		logVoice('Stopping screen share stream');

		localScreenShareStream?.getTracks().forEach((track) => {
			logVoice('Stopping screen share track', { track });

			track.stop();
			localScreenShareStream.removeTrack(track);
		});

		localScreenShareProducer.current?.close();
		localScreenShareProducer.current = undefined;
		localScreenShareAudioProducer.current?.close();
		localScreenShareAudioProducer.current = undefined;
		standbyDisplayAudioTrackRef.current = undefined;
		standbyDisplayAudioStreamRef.current = undefined;

		void cleanupDesktopAppAudio();

		setLocalScreenShare(undefined);
		setLocalScreenShareAudio(undefined);
	}, [
		cleanupDesktopAppAudio,
		localScreenShareStream,
		setLocalScreenShare,
		setLocalScreenShareAudio,
		localScreenShareProducer,
		localScreenShareAudioProducer,
	]);

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

				let useSidecarAudio =
					desktopBridge &&
					desktopSelection &&
					(audioMode === ScreenAudioMode.APP || (audioMode === ScreenAudioMode.SYSTEM && sidecarSupported));

				const sidecarAudioLabel = audioMode === ScreenAudioMode.SYSTEM ? 'System audio' : 'Per-app audio';

				// Always request loopback audio from getDisplayMedia in system mode
				// so it is available as a fallback if the sidecar fails.  When the
				// sidecar successfully captures audio, the loopback track is stopped
				// and removed before the producer is created.
				const shouldCaptureDisplayAudio = audioMode === ScreenAudioMode.SYSTEM;
				const requestedScreenResolution = getResWidthHeight(devices?.screenResolution);

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

				logVoice('Screen share stream obtained', { stream });

				const videoTrack = stream.getVideoTracks()[0];
				let audioTrack: MediaStreamTrack | undefined = stream.getAudioTracks()[0];
				standbyDisplayAudioTrackRef.current = undefined;
				standbyDisplayAudioStreamRef.current = undefined;

				if (videoTrack) {
					await publishScreenShareTrack(stream, videoTrack, {
						onTrackEnded: handlers.onVideoTrackEnded,
					});
					// Surface the active share as soon as the video producer exists.
					// Optional audio setup can continue after the preview is already live.
					handlers.onVideoTrackStarted?.();

					if (useSidecarAudio && desktopBridge && desktopSelection) {
						try {
							const captureInput: TStartAppAudioCaptureInput = {
								sourceId: desktopSelection.sourceId,
							};

							if (audioMode === ScreenAudioMode.APP) {
								captureInput.appAudioTargetId = desktopSelection.appAudioTargetId;
							}

							logVoice('Starting sidecar audio capture', {
								sourceId: captureInput.sourceId,
								appAudioTargetId: captureInput.appAudioTargetId,
								mode: audioMode === ScreenAudioMode.SYSTEM ? 'system-exclude' : 'per-app',
							});
							const appAudioSession = await desktopBridge.startAppAudioCapture(captureInput);
							logVoice('Sidecar capture started', {
								sessionId: appAudioSession.sessionId,
								targetId: appAudioSession.targetId,
							});
							const appAudioPipeline = await createDesktopAppAudioPipeline(appAudioSession, {
								mode: 'stable',
								logLabel: audioMode === ScreenAudioMode.SYSTEM ? 'system-audio' : 'per-app-audio',
								insertSilenceOnDroppedFrames: true,
								emitQueueTelemetry: true,
								queueTelemetryIntervalMs: 1_000,
							});
							let hasReceivedSessionFrame = false;

							appAudioSessionRef.current = appAudioSession;
							appAudioPipelineRef.current = appAudioPipeline;

							const startupTimeout = window.setTimeout(() => {
								if (hasReceivedSessionFrame || appAudioSessionRef.current?.sessionId !== appAudioSession.sessionId) {
									return;
								}

								logVoice('Sidecar produced no audio frames after startup', {
									sessionId: appAudioSession.sessionId,
									targetId: appAudioSession.targetId,
								});
								toast.warning(
									`${sidecarAudioLabel} started but produced no audio frames. Screen video will continue without shared audio.`,
								);
								localScreenShareAudioProducer.current?.close();
								localScreenShareAudioProducer.current = undefined;
								setLocalScreenShareAudio(undefined);
								void cleanupDesktopAppAudio({
									stopCapture: true,
									preserveCurrentAudio: false,
								});
							}, 3000);
							appAudioStartupTimeoutRef.current = startupTimeout;

							removeAppAudioFrameSubscriptionRef.current?.();
							removeAppAudioFrameSubscriptionRef.current = desktopBridge.subscribeAppAudioFrames((frame) => {
								if (frame.sessionId === appAudioSession.sessionId) {
									if (!hasReceivedSessionFrame) {
										logVoice('Received first sidecar audio frame', {
											sessionId: frame.sessionId,
											targetId: frame.targetId,
										});
									}

									hasReceivedSessionFrame = true;

									if (appAudioStartupTimeoutRef.current !== undefined) {
										window.clearTimeout(appAudioStartupTimeoutRef.current);
										appAudioStartupTimeoutRef.current = undefined;
									}
								}
								appAudioPipelineRef.current?.pushFrame(frame);
							});

							removeAppAudioStatusSubscriptionRef.current?.();
							removeAppAudioStatusSubscriptionRef.current = desktopBridge.subscribeAppAudioStatus(
								(statusEvent: TAppAudioStatusEvent) => {
									logVoice('Received sidecar audio status event', {
										sessionId: statusEvent.sessionId,
										targetId: statusEvent.targetId,
										reason: statusEvent.reason,
										error: statusEvent.error,
									});
									if (statusEvent.sessionId !== appAudioSessionRef.current?.sessionId) {
										return;
									}

									void (async () => {
										if (appAudioStartupTimeoutRef.current !== undefined) {
											window.clearTimeout(appAudioStartupTimeoutRef.current);
											appAudioStartupTimeoutRef.current = undefined;
										}
										toast.warning(
											statusEvent.error
												? `${sidecarAudioLabel} capture ended (${statusEvent.reason}): ${statusEvent.error}`
												: `${sidecarAudioLabel} capture ended (${statusEvent.reason}). Screen video will continue without shared audio.`,
										);
										localScreenShareAudioProducer.current?.close();
										localScreenShareAudioProducer.current = undefined;
										setLocalScreenShareAudio(undefined);

										await cleanupDesktopAppAudio({
											stopCapture: false,
											preserveCurrentAudio: false,
										});
									})();
								},
							);

							if (audioTrack) {
								audioTrack.stop();
								stream.removeTrack(audioTrack);
								audioTrack = undefined;
							}
						} catch (error) {
							logVoice('Failed to start sidecar audio capture', {
								error,
							});
							const capabilities = await desktopBridge
								.getCapabilities()
								.then((nextCapabilities) => normalizeDesktopCapabilities(nextCapabilities))
								.catch(() => undefined);
							const issueToastMessage = getDesktopAudioIssueToastMessage(capabilities, audioMode);
							await cleanupDesktopAppAudio();

							if (audioMode === ScreenAudioMode.SYSTEM) {
								logVoice('Falling back to display-media loopback for system audio');
								toast.warning(
									issueToastMessage
										? `${issueToastMessage} Falling back to standard system audio (without echo exclusion).`
										: 'Sidecar audio capture failed. Falling back to standard system audio (without echo exclusion).',
								);
								useSidecarAudio = false;
							} else {
								toast.warning(
									issueToastMessage
										? `${issueToastMessage} Continuing without shared audio.`
										: `${sidecarAudioLabel} capture failed. Continuing without shared audio.`,
								);

								if (audioTrack) {
									audioTrack.stop();
									stream.removeTrack(audioTrack);
									audioTrack = undefined;
								}
							}
						}
					}

					if (useSidecarAudio && appAudioPipelineRef.current?.track) {
						const appAudioTrack = appAudioPipelineRef.current.track;
						await publishScreenShareAudioTrack(appAudioPipelineRef.current.stream, appAudioTrack, {
							onTrackEnded: () => {
								return cleanupDesktopAppAudio({
									stopCapture: false,
								});
							},
						});
					} else if (audioTrack) {
						logVoice('Obtained audio track', { audioTrack });
						await publishScreenShareAudioTrack(new MediaStream([audioTrack]), audioTrack);
					} else {
						await cleanupDesktopAppAudio();
						setLocalScreenShareAudio(undefined);
					}

					return videoTrack;
				} else {
					throw new Error('No video track obtained for screen share');
				}
			} catch (error) {
				stream?.getTracks().forEach((track) => {
					track.stop();
				});
				standbyDisplayAudioTrackRef.current = undefined;
				standbyDisplayAudioStreamRef.current = undefined;
				await cleanupDesktopAppAudio();

				logVoice('Error starting screen share stream', { error });
				throw error;
			}
		},
		[
			cleanupDesktopAppAudio,
			devices.screenAudioMode,
			devices.screenFramerate,
			devices.screenResolution,
			localScreenShareAudioProducer,
			publishScreenShareAudioTrack,
			publishScreenShareTrack,
			setLocalScreenShareAudio,
		],
	);

	const cleanup = useCallback(() => {
		logVoice('Running voice provider cleanup');

		void cleanupDesktopAppAudio();
		void cleanupMicAudioPipeline();
		stopMonitoring();
		resetStats();
		stopAllVoiceActivityMonitoring();
		clearLocalStreams();
		clearRemoteUserStreams();
		clearExternalStreams();
		cleanupTransports();
		deviceRef.current = undefined;
		routerRtpCapabilities.current = null;
		sendRtpCapabilities.current = null;
		setVoiceEventRtpCapabilities(null);

		setConnectionStatus(ConnectionStatus.DISCONNECTED);
	}, [
		stopMonitoring,
		resetStats,
		stopAllVoiceActivityMonitoring,
		cleanupDesktopAppAudio,
		cleanupMicAudioPipeline,
		clearLocalStreams,
		clearRemoteUserStreams,
		clearExternalStreams,
		cleanupTransports,
	]);

	voiceCleanupRef.current = cleanup;

	const init = useCallback(
		async (
			incomingRouterRtpCapabilities: RtpCapabilities,
			channelId: number,
			opts?: {
				producerTransportParams?: TTransportParams;
				consumerTransportParams?: TTransportParams;
				existingProducers?: TRemoteProducerIds;
				playJoinSound?: boolean;
			},
		) => {
			logVoice('Initializing voice provider', {
				incomingRouterRtpCapabilities,
				channelId,
				prefetched: !!opts?.producerTransportParams,
			});

			cleanup();
			hasHandledTransportFailureRef.current = false;

			let micPrepPromise: Promise<TPreparedMicPipeline | undefined> | undefined;

			try {
				setLoading(true);
				setConnectionStatus(ConnectionStatus.CONNECTING);

				if (opts?.playJoinSound !== false) {
					playSound(SoundType.OWN_USER_JOINED_VOICE_CHANNEL);
				}

				routerRtpCapabilities.current = incomingRouterRtpCapabilities;

				const device = await Device.factory();

				// Start mic acquisition + WASM pipeline immediately — these have no
				// dependency on the mediasoup device or transports and are the slowest
				// part of startMicStream. Running them concurrently with device.load()
				// and transport creation saves ~200-300ms on join.
				micPrepPromise = prepareMicPipeline().catch(async (error) => {
					logVoice('Error preparing microphone pipeline', { error });
					await cleanupMicAudioPipeline();
					setLocalAudioStream(undefined);
					return undefined;
				});

				await device.load({
					routerRtpCapabilities: incomingRouterRtpCapabilities,
				});
				deviceRef.current = device;
				sendRtpCapabilities.current = device.rtpCapabilities;

				await Promise.all([
					createProducerTransport(device, opts?.producerTransportParams),
					createConsumerTransport(device, opts?.consumerTransportParams),
				]);
				setVoiceEventRtpCapabilities(device.rtpCapabilities);

				const [, micPrepResult] = await Promise.all([
					consumeExistingProducers(device.rtpCapabilities, undefined, opts?.existingProducers),
					micPrepPromise,
				]);

				// Mic failures are non-fatal — voice join continues without a mic.
				if (micPrepResult) {
					try {
						await produceMicTrack(micPrepResult);
					} catch (error) {
						logVoice('Error attaching microphone to transport', { error });
						await cleanupMicAudioPipeline();
						setLocalAudioStream(undefined);
					}
				}

				startMonitoring(producerTransport.current, consumerTransport.current);
				setConnectionStatus(ConnectionStatus.CONNECTED);
				setLoading(false);
			} catch (error) {
				logVoice('Error initializing voice provider', { error });

				// Clean up the prestarted mic pipeline — it may have acquired the
				// microphone and spun up the WASM worker before the failure occurred.
				await micPrepPromise;
				await cleanupMicAudioPipeline();
				setLocalAudioStream(undefined);

				setConnectionStatus(ConnectionStatus.FAILED);
				setLoading(false);

				throw error;
			}
		},
		[
			cleanup,
			prepareMicPipeline,
			produceMicTrack,
			cleanupMicAudioPipeline,
			setLocalAudioStream,
			createProducerTransport,
			createConsumerTransport,
			consumeExistingProducers,
			startMonitoring,
			producerTransport,
			consumerTransport,
		],
	);

	const recoverTransportSession = useCallback(async (): Promise<boolean> => {
		if (transportRecoveryPromiseRef.current) {
			return transportRecoveryPromiseRef.current;
		}

		const recoveryPromise = (async () => {
			try {
				if (!isConnectedRef.current) {
					logVoice('Skipping transport recovery because server connection is unavailable');
					return false;
				}

				if (currentVoiceChannelIdRef.current === undefined) {
					logVoice('Skipping transport recovery because the user is no longer in voice');
					return false;
				}

				if (!routerRtpCapabilities.current) {
					logVoice('Skipping transport recovery because router RTP capabilities are unavailable');
					return false;
				}

				let nonceRestarts = 0;

				for (let attempt = 0; attempt < RECOVERY_MAX_ATTEMPTS; attempt++) {
					if (attempt > 0) {
						await new Promise<void>((resolve) => setTimeout(resolve, RECOVERY_BACKOFF_MS[attempt - 1]));

						if (!isConnectedRef.current || currentVoiceChannelIdRef.current === undefined) {
							logVoice('Aborting transport recovery after backoff: connection or channel lost');
							return false;
						}
					}

					const nonceAtStart = voiceSessionReconnectNonceRef.current;
					const isNonceStale = () => voiceSessionReconnectNonceRef.current !== nonceAtStart;
					const throwIfNonceStale = (stage: string) => {
						if (isNonceStale()) {
							throw new VoiceSessionReconnectChangedError(stage);
						}
					};

					try {
						logVoice('Attempting in-session voice transport recovery', {
							attempt: attempt + 1,
							channelId: currentVoiceChannelIdRef.current,
						});

						const watchedStreamsSnapshot = captureWatchedRemoteStreams();

						setConnectionStatus(ConnectionStatus.CONNECTING);
						stopMonitoring();
						resetStats();
						clearRemoteUserStreams();
						clearExternalStreams();
						setVoiceEventRtpCapabilities(null);
						cleanupTransports();

						let device = await withRecoveryTimeout(ensureVoiceDeviceLoaded());

						throwIfNonceStale('device load');

						let currentRtpCapabilities = device.rtpCapabilities;
						let recoveryJoinResult: TRecoveryJoinResult | undefined;

						try {
							await withRecoveryTimeout(
								Promise.all([createProducerTransport(device), createConsumerTransport(device)]),
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

							recoveryJoinResult = await withRecoveryTimeout(rejoinVoiceSession(recoveryChannelId));
							throwIfNonceStale('voice rejoin');

							device = recoveryJoinResult.device;
							currentRtpCapabilities = device.rtpCapabilities;

							await withRecoveryTimeout(
								Promise.all([
									createProducerTransport(device, recoveryJoinResult.producerTransportParams),
									createConsumerTransport(device, recoveryJoinResult.consumerTransportParams),
								]),
							);
						}

						throwIfNonceStale('transport creation');

						sendRtpCapabilities.current = currentRtpCapabilities;
						setVoiceEventRtpCapabilities(currentRtpCapabilities);

						const republishTasks: Promise<void>[] = [];

						const currentAudioStream = localAudioStreamRef.current;
						const currentAudioTrack = currentAudioStream?.getAudioTracks()[0];
						if (currentAudioStream && currentAudioTrack && currentAudioTrack.readyState === 'live') {
							republishTasks.push(publishMicTrack(currentAudioStream, currentAudioTrack));
						}

						const currentVideoStream = localVideoStreamRef.current;
						const currentVideoTrack = currentVideoStream?.getVideoTracks()[0];
						if (currentVideoStream && currentVideoTrack && currentVideoTrack.readyState === 'live') {
							republishTasks.push(publishWebcamTrack(currentVideoStream, currentVideoTrack));
						}

						const currentScreenShareStream = localScreenShareStreamRef.current;
						const currentScreenShareTrack = currentScreenShareStream?.getVideoTracks()[0];
						if (currentScreenShareStream && currentScreenShareTrack && currentScreenShareTrack.readyState === 'live') {
							republishTasks.push(publishScreenShareTrack(currentScreenShareStream, currentScreenShareTrack));
						}

						const currentScreenShareAudioStream = localScreenShareAudioStreamRef.current;
						const currentScreenShareAudioTrack = currentScreenShareAudioStream?.getAudioTracks()[0];
						if (
							currentScreenShareAudioStream &&
							currentScreenShareAudioTrack &&
							currentScreenShareAudioTrack.readyState === 'live'
						) {
							const shouldCleanupDesktopAudio = appAudioPipelineRef.current?.track === currentScreenShareAudioTrack;

							republishTasks.push(
								publishScreenShareAudioTrack(currentScreenShareAudioStream, currentScreenShareAudioTrack, {
									onTrackEnded: shouldCleanupDesktopAudio
										? () => {
												return cleanupDesktopAppAudio({
													stopCapture: false,
												});
											}
										: undefined,
								}),
							);
						}

						await withRecoveryTimeout(
							Promise.all([
								consumeExistingProducers(currentRtpCapabilities, undefined, recoveryJoinResult?.existingProducers),
								...republishTasks,
							]),
						);

						throwIfNonceStale('consume/republish');

						const restoreWatchTasks: Promise<void>[] = [];

						Object.entries(watchedStreamsSnapshot.remoteUserStreams).forEach(([remoteId, kinds]) => {
							const numericRemoteId = Number(remoteId);

							kinds.forEach((kind) => {
								restoreWatchTasks.push(consume(numericRemoteId, kind, currentRtpCapabilities));
							});
						});

						Object.entries(watchedStreamsSnapshot.externalStreams).forEach(([streamId, watchedState]) => {
							const numericStreamId = Number(streamId);

							if (watchedState.audio) {
								restoreWatchTasks.push(consume(numericStreamId, StreamKind.EXTERNAL_AUDIO, currentRtpCapabilities));
							}

							if (watchedState.video) {
								restoreWatchTasks.push(consume(numericStreamId, StreamKind.EXTERNAL_VIDEO, currentRtpCapabilities));
							}
						});

						await withRecoveryTimeout(Promise.all(restoreWatchTasks));

						throwIfNonceStale('watch restoration');

						startMonitoring(producerTransport.current, consumerTransport.current);
						setConnectionStatus(ConnectionStatus.CONNECTED);
						logVoice('Voice transport recovery completed successfully');

						return true;
					} catch (error) {
						if (error instanceof VoiceSessionReconnectChangedError) {
							nonceRestarts += 1;

							if (nonceRestarts > RECOVERY_MAX_NONCE_RESTARTS) {
								logVoice('Voice transport recovery abandoned: too many session changes', {
									nonceRestarts,
								});
								setConnectionStatus(ConnectionStatus.FAILED);
								return false;
							}

							logVoice('Voice session changed during transport recovery, restarting attempt', {
								attempt: attempt + 1,
								nonceRestarts,
								error,
							});
							attempt -= 1;
							continue;
						}

						const isLastAttempt = attempt === RECOVERY_MAX_ATTEMPTS - 1;

						if (!isLastAttempt && !isNonRetriableTrpcError(error)) {
							logVoice('Voice transport recovery attempt failed, retrying', {
								attempt: attempt + 1,
								error,
							});
							continue;
						}

						logVoice('Voice transport recovery failed', { error });
						setConnectionStatus(ConnectionStatus.FAILED);
						return false;
					}
				}

				return false;
			} finally {
				transportRecoveryPromiseRef.current = undefined;
			}
		})();

		transportRecoveryPromiseRef.current = recoveryPromise;
		return recoveryPromise;
	}, [
		captureWatchedRemoteStreams,
		clearExternalStreams,
		clearRemoteUserStreams,
		cleanupDesktopAppAudio,
		cleanupTransports,
		consume,
		consumeExistingProducers,
		createConsumerTransport,
		createProducerTransport,
		ensureVoiceDeviceLoaded,
		producerTransport,
		consumerTransport,
		publishMicTrack,
		publishScreenShareAudioTrack,
		publishScreenShareTrack,
		publishWebcamTrack,
		resetStats,
		rejoinVoiceSession,
		startMonitoring,
		stopMonitoring,
	]);

	recoverTransportSessionRef.current = recoverTransportSession;

	const { isStartingScreenShare, setMicMuted, toggleMic, toggleSound, toggleWebcam, toggleScreenShare } =
		useVoiceControls({
			startMicStream,
			localAudioStream,
			startWebcamStream,
			stopWebcamStream,
			startScreenShareStream,
			stopScreenShareStream,
			requestScreenShareSelection: getDesktopBridge() ? requestDesktopScreenShareSelection : undefined,
		});

	const setMicMutedRef = useRef(setMicMuted);
	const ownMicMutedRef = useRef(ownVoiceState.micMuted);
	const canSpeakRef = useRef(channelCan(ChannelPermission.SPEAK));

	useEffect(() => {
		setMicMutedRef.current = setMicMuted;
	}, [setMicMuted]);

	useEffect(() => {
		ownMicMutedRef.current = ownVoiceState.micMuted;
	}, [ownVoiceState.micMuted]);

	useEffect(() => {
		isConnectedRef.current = isConnected;
		currentVoiceChannelIdRef.current = currentVoiceChannelId;
		canSpeakRef.current = channelCan(ChannelPermission.SPEAK);
		voiceSessionReconnectNonceRef.current = voiceSessionReconnectNonce;
	}, [channelCan, currentVoiceChannelId, isConnected, voiceSessionReconnectNonce]);

	useEffect(() => {
		const pushTarget = isPushToMuteHeldRef.current ? true : isPushToTalkHeldRef.current ? false : undefined;

		if (pushTarget === undefined || micMutedBeforePushRef.current === undefined || confirmedOwnMicMuted === undefined) {
			return;
		}

		if (confirmedOwnMicMuted !== pushTarget) {
			micMutedBeforePushRef.current = confirmedOwnMicMuted;
		}
	}, [confirmedOwnMicMuted]);

	const applyPushMicOverride = useCallback(() => {
		if (isPushToMuteHeldRef.current) {
			void setMicMutedRef.current(true, { playSound: false });
			return;
		}

		if (isPushToTalkHeldRef.current) {
			void setMicMutedRef.current(false, { playSound: false });
			return;
		}

		if (typeof micMutedBeforePushRef.current === 'boolean') {
			void setMicMutedRef.current(micMutedBeforePushRef.current, {
				playSound: false,
			});
		}

		micMutedBeforePushRef.current = undefined;
	}, []);

	useEffect(() => {
		const desktopBridge = getDesktopBridge();

		if (!desktopBridge) {
			return;
		}

		void desktopBridge
			.setGlobalPushKeybinds({
				pushToTalkKeybind: devices.pushToTalkKeybind,
				pushToMuteKeybind: devices.pushToMuteKeybind,
			})
			.then((result) => {
				if (result.errors.length > 0) {
					logVoice('Global push keybind registration issues', result);
					toast.warning(result.errors[0]);
				}
			})
			.catch((error) => {
				logVoice('Failed to register global push keybinds', { error });
			});

		const removeGlobalKeybindSubscription = desktopBridge.subscribeGlobalPushKeybindEvents((event) => {
			if (currentVoiceChannelIdRef.current === undefined || !canSpeakRef.current) {
				if (event.kind === 'talk') {
					isPushToTalkHeldRef.current = false;
				}

				if (event.kind === 'mute') {
					isPushToMuteHeldRef.current = false;
				}

				applyPushMicOverride();
				return;
			}

			if (
				!isPushToTalkHeldRef.current &&
				!isPushToMuteHeldRef.current &&
				event.active &&
				micMutedBeforePushRef.current === undefined
			) {
				micMutedBeforePushRef.current = ownMicMutedRef.current;
			}

			if (event.kind === 'talk') {
				isPushToTalkHeldRef.current = event.active;
			}

			if (event.kind === 'mute') {
				isPushToMuteHeldRef.current = event.active;
			}

			applyPushMicOverride();
		});

		return () => {
			removeGlobalKeybindSubscription();
			isPushToTalkHeldRef.current = false;
			isPushToMuteHeldRef.current = false;
			applyPushMicOverride();
			void desktopBridge.setGlobalPushKeybinds({}).catch((error) => {
				logVoice('Failed to clear global push keybinds', { error });
			});
		};
	}, [applyPushMicOverride, devices.pushToMuteKeybind, devices.pushToTalkKeybind]);

	useEffect(() => {
		if (currentVoiceChannelId === undefined || !channelCan(ChannelPermission.SPEAK)) {
			isPushToTalkHeldRef.current = false;
			isPushToMuteHeldRef.current = false;
			applyPushMicOverride();
		}
	}, [applyPushMicOverride, channelCan, currentVoiceChannelId]);

	useVoiceEvents({
		consume,
		addPendingStream,
		removePendingStream,
		removeRemoteUserStream,
		removeExternalStreamTrack,
		removeExternalStream,
		clearRemoteUserStreamsForUser,
		clearPendingStreamsForUser,
		onTransportFailure,
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
			loading,
			connectionStatus,
			transportStats,
			audioVideoRefsMap: audioVideoRefsMap.current,
			getOrCreateRefs,
			acceptStream,
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
		}),
		[
			loading,
			connectionStatus,
			transportStats,
			getOrCreateRefs,
			acceptStream,
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
		],
	);

	return (
		<VoiceProviderContext.Provider value={contextValue}>
			<VoiceActivityContext.Provider value={voiceActivityStoreRef.current}>
				<VolumeControlProvider>
					<div className="relative">
						<FloatingPinnedCard
							remoteUserStreams={remoteUserStreams}
							externalStreams={externalStreams}
							localScreenShareStream={localScreenShareStream}
							localVideoStream={localVideoStream}
						/>
						{children}
					</div>
				</VolumeControlProvider>
			</VoiceActivityContext.Provider>
		</VoiceProviderContext.Provider>
	);
});

export { VoiceActivityContext, VoiceProvider, VoiceProviderContext };
