import {
	ChannelPermission,
	StreamKind,
	type TExternalStream,
	type TRemoteProducerIds,
	type TTransportParams,
	type TVoiceUserState,
} from '@sharkord/shared';
import { Device } from 'mediasoup-client';
import type { RtpCapabilities, RtpCodecCapability } from 'mediasoup-client/types';
import { createContext, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { requestScreenShareSelection as requestScreenShareSelectionDialog } from '@/features/dialogs/actions';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useChannelCan, useIsConnected } from '@/features/server/hooks';
import {
	clearPendingVoiceReconnectChannelId,
	getPendingVoiceReconnectChannelId,
	getPendingVoiceReconnectRetryCount,
	incrementPendingVoiceReconnectRetryCount,
	setPendingVoiceReconnectChannelId,
} from '@/features/server/reconnect-state';
import { useServerStore } from '@/features/server/slice';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { joinVoice, leaveVoiceSilently } from '@/features/server/voice/actions';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import { logVoice } from '@/helpers/browser-logger';
import { getResWidthHeight } from '@/helpers/get-res-with-height';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import {
	ScreenAudioMode,
	type TAppAudioSession,
	type TAppAudioStatusEvent,
	type TDesktopScreenShareSelection,
} from '@/runtime/types';
import {
	getStrengthDefaults,
	MicQualityMode,
	type TDeviceSettings,
	type TRemoteStreams,
	VideoCodecPreference,
	type VoiceFilterStrength,
} from '@/types';
import { useDevices } from '../devices-provider/hooks/use-devices';
import { createDesktopAppAudioPipeline, type TDesktopAppAudioPipeline } from './desktop-app-audio';
import { FloatingPinnedCard } from './floating-pinned-card';
import { useLocalStreams } from './hooks/use-local-streams';
import { getPendingStreamKey, usePendingStreams } from './hooks/use-pending-streams';
import { type TExternalStreamsMap, useRemoteStreams } from './hooks/use-remote-streams';
import { type TransportStatsData, useTransportStats } from './hooks/use-transport-stats';
import { useTransports } from './hooks/use-transports';
import { useVoiceControls } from './hooks/use-voice-controls';
import { useVoiceEvents } from './hooks/use-voice-events';
import {
	createMicAudioProcessingPipeline,
	createNativeSidecarMicCapturePipeline,
	nowSteadyEpochMs,
	resolveSidecarDeviceId,
	type TMicAudioProcessingPipeline,
} from './mic-audio-processing';
import { createMicReferenceAudioPipeline, type TMicReferenceAudioPipeline } from './mic-reference-audio';
import { getVideoBitratePolicy } from './video-bitrate-policy';
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
const AUDIO_OPUS_TARGET_BITRATE_BPS = 128_000;
const AUDIO_OPUS_PACKET_LOSS_PERC = 15;
const MAX_VOICE_REJOIN_RETRIES = 5;
const VOICE_REJOIN_RETRY_DELAY_MS = 2_000;
const AUDIO_OPUS_CODEC_OPTIONS = {
	opusMaxAverageBitrate: AUDIO_OPUS_TARGET_BITRATE_BPS,
	opusDtx: false,
	opusFec: true,
	opusPacketLossPerc: AUDIO_OPUS_PACKET_LOSS_PERC,
} as const;

type ResolvedMicProcessingConfig = {
	sidecarVoiceProcessingEnabled: boolean;
	wasmNoiseSuppressionEnabled: boolean;
	browserAutoGainControl: boolean;
	browserNoiseSuppression: boolean;
	browserEchoCancellation: boolean;
	sidecarNoiseSuppression: boolean;
	sidecarAutoGainControl: boolean;
	sidecarEchoCancellation: boolean;
	sidecarSuppressionLevel: VoiceFilterStrength;
	sidecarDfnMix: number;
	sidecarDfnAttenuationLimitDb?: number;
	sidecarExperimentalAggressiveMode: boolean;
	sidecarNoiseGateFloorDbfs?: number;
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

const resolveMicProcessingConfig = (
	devices: TDeviceSettings,
	hasDesktopBridge: boolean,
): ResolvedMicProcessingConfig => {
	const defaults = getStrengthDefaults(devices.voiceFilterStrength);
	const browserWasmNoiseSuppressionEnabled =
		import.meta.env.DEV && devices.wasmNoiseSuppressionEnabled && devices.noiseSuppression;

	if (devices.micQualityMode === MicQualityMode.EXPERIMENTAL) {
		const sidecarVoiceProcessingEnabled = hasDesktopBridge;

		return {
			sidecarVoiceProcessingEnabled,
			wasmNoiseSuppressionEnabled: !sidecarVoiceProcessingEnabled && browserWasmNoiseSuppressionEnabled,
			browserAutoGainControl: false,
			browserNoiseSuppression: false,
			browserEchoCancellation: false,
			sidecarNoiseSuppression: devices.noiseSuppression,
			sidecarAutoGainControl: devices.autoGainControl,
			sidecarEchoCancellation: devices.echoCancellation,
			sidecarSuppressionLevel: devices.voiceFilterStrength,
			sidecarDfnMix: defaults.dfnMix,
			sidecarDfnAttenuationLimitDb: defaults.dfnAttenuationLimitDb,
			sidecarExperimentalAggressiveMode: defaults.dfnExperimentalAggressiveMode,
			sidecarNoiseGateFloorDbfs: defaults.dfnNoiseGateFloorDbfs,
		};
	}

	// Standard (AUTO) and legacy MANUAL — browser-only, no sidecar
	return {
		sidecarVoiceProcessingEnabled: false,
		wasmNoiseSuppressionEnabled: browserWasmNoiseSuppressionEnabled,
		browserAutoGainControl: devices.autoGainControl,
		browserNoiseSuppression: browserWasmNoiseSuppressionEnabled ? false : devices.noiseSuppression,
		browserEchoCancellation: devices.echoCancellation,
		sidecarNoiseSuppression: devices.noiseSuppression,
		sidecarAutoGainControl: devices.autoGainControl,
		sidecarEchoCancellation: devices.echoCancellation,
		sidecarSuppressionLevel: devices.voiceFilterStrength,
		sidecarDfnMix: defaults.dfnMix,
		sidecarDfnAttenuationLimitDb: defaults.dfnAttenuationLimitDb,
		sidecarExperimentalAggressiveMode: defaults.dfnExperimentalAggressiveMode,
		sidecarNoiseGateFloorDbfs: defaults.dfnNoiseGateFloorDbfs,
	};
};

const didMicCaptureSettingsChange = (previousDevices: TDeviceSettings, nextDevices: TDeviceSettings) => {
	return (
		previousDevices.microphoneId !== nextDevices.microphoneId ||
		previousDevices.micQualityMode !== nextDevices.micQualityMode ||
		previousDevices.echoCancellation !== nextDevices.echoCancellation ||
		previousDevices.noiseSuppression !== nextDevices.noiseSuppression ||
		previousDevices.wasmNoiseSuppressionEnabled !== nextDevices.wasmNoiseSuppressionEnabled ||
		previousDevices.autoGainControl !== nextDevices.autoGainControl ||
		previousDevices.voiceFilterStrength !== nextDevices.voiceFilterStrength ||
		previousDevices.sidecarDfnMix !== nextDevices.sidecarDfnMix ||
		previousDevices.sidecarDfnAttenuationLimitDb !== nextDevices.sidecarDfnAttenuationLimitDb ||
		previousDevices.sidecarExperimentalAggressiveMode !== nextDevices.sidecarExperimentalAggressiveMode ||
		previousDevices.sidecarNoiseGateFloorDbfs !== nextDevices.sidecarNoiseGateFloorDbfs
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

type TTrackedExternalWatchState = {
	audio: boolean;
	video: boolean;
};

type TChannelExternalStreams = {
	[streamId: number]: TExternalStream;
};

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

const getAudioContextClass = () => {
	return (
		window.AudioContext ||
		(
			window as typeof window & {
				webkitAudioContext?: typeof AudioContext;
			}
		).webkitAudioContext
	);
};

const createMicGainPipeline = async (
	inputStream: MediaStream,
	volume: number,
): Promise<TMicGainPipeline | undefined> => {
	const inputTrack = inputStream.getAudioTracks()[0];

	if (!inputTrack) {
		return undefined;
	}

	const AudioContextClass = getAudioContextClass();

	if (!AudioContextClass) {
		return undefined;
	}

	const audioContext = new AudioContextClass();

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
		await audioContext.close();
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

			if (audioContext.state !== 'closed') {
				await audioContext.close();
			}
		},
	};
};

const playbackCaptureStreamCache = new WeakMap<HTMLMediaElement, MediaStream>();

const getPlaybackCaptureStream = (element: HTMLMediaElement | null | undefined): MediaStream | undefined => {
	if (!element) {
		return undefined;
	}

	const cachedStream = playbackCaptureStreamCache.get(element);
	if (cachedStream) {
		return cachedStream;
	}

	const mediaElement = element as HTMLMediaElement & {
		captureStream?: () => MediaStream;
		mozCaptureStream?: () => MediaStream;
	};
	const captureStream = mediaElement.captureStream ?? mediaElement.mozCaptureStream;

	if (!captureStream) {
		return undefined;
	}

	try {
		const stream = captureStream.call(mediaElement);
		playbackCaptureStreamCache.set(element, stream);
		return stream;
	} catch {
		return undefined;
	}
};

const collectPlaybackReferenceStreams = (
	remoteUserStreams: TRemoteStreams,
	externalStreams: TExternalStreamsMap,
	audioVideoRefs: Map<number, AudioVideoRefs>,
	playbackEnabled: boolean,
): MediaStream[] => {
	if (!playbackEnabled) {
		return [];
	}

	const streams: MediaStream[] = [];
	const seenTrackIds = new Set<string>();
	const addTrack = (track: MediaStreamTrack | undefined) => {
		if (!track || track.kind !== 'audio' || track.readyState !== 'live') {
			return;
		}

		if (seenTrackIds.has(track.id)) {
			return;
		}

		seenTrackIds.add(track.id);
		streams.push(new MediaStream([track]));
	};

	const addStream = (stream: MediaStream | undefined) => {
		stream?.getAudioTracks().forEach((track) => {
			addTrack(track);
		});
	};

	const addCapturedAudio = (element: HTMLMediaElement | null | undefined): boolean => {
		const trackCountBefore = seenTrackIds.size;
		addStream(getPlaybackCaptureStream(element));
		return seenTrackIds.size > trackCountBefore;
	};

	Object.entries(remoteUserStreams).forEach(([remoteIdKey, userStreams]) => {
		if (!userStreams) {
			return;
		}

		const refs = audioVideoRefs.get(Number(remoteIdKey));
		if (!addCapturedAudio(refs?.audioRef.current)) {
			addStream(userStreams[StreamKind.AUDIO]);
		}

		if (!addCapturedAudio(refs?.screenShareRef.current) && !addCapturedAudio(refs?.screenShareAudioRef.current)) {
			addStream(userStreams[StreamKind.SCREEN_AUDIO]);
		}
	});

	Object.entries(externalStreams).forEach(([remoteIdKey, streamState]) => {
		const refs = audioVideoRefs.get(Number(remoteIdKey));
		if (!addCapturedAudio(refs?.externalAudioRef.current)) {
			addStream(streamState.audioStream);
		}
	});

	return streams;
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

type TVoiceProviderProps = {
	children: React.ReactNode;
};

const VoiceProvider = memo(({ children }: TVoiceProviderProps) => {
	const [loading, setLoading] = useState(false);
	const [voiceReconnectRetryToken, setVoiceReconnectRetryToken] = useState(0);
	const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
	const routerRtpCapabilities = useRef<RtpCapabilities | null>(null);
	const sendRtpCapabilities = useRef<RtpCapabilities | null>(null);
	const audioVideoRefsMap = useRef<Map<number, AudioVideoRefs>>(new Map());
	const ownVoiceState = useOwnVoiceState();
	const currentVoiceChannelId = useCurrentVoiceChannelId();
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
	const micReferenceAudioPipelineRef = useRef<TMicReferenceAudioPipeline | undefined>(undefined);
	const micReferenceSequenceRef = useRef(0);
	const remoteUserStreamsRef = useRef<TRemoteStreams>({});
	const externalStreamsRef = useRef<TExternalStreamsMap>({});
	const standbyDisplayAudioTrackRef = useRef<MediaStreamTrack | undefined>(undefined);
	const standbyDisplayAudioStreamRef = useRef<MediaStream | undefined>(undefined);
	const isPushToTalkHeldRef = useRef(false);
	const isPushToMuteHeldRef = useRef(false);
	const micMutedBeforePushRef = useRef<boolean | undefined>(undefined);
	const reconnectingVoiceRef = useRef(false);
	const reconnectingVoiceGenerationRef = useRef(0);
	const previousDevicesRef = useRef<TDeviceSettings | undefined>(undefined);
	const watchedExternalStreamsRef = useRef<Record<string, TTrackedExternalWatchState>>({});

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

	const voiceCleanupRef = useRef<(() => void) | undefined>(undefined);
	const hasHandledTransportFailureRef = useRef(false);
	const currentVoiceChannelIdRef = useRef(currentVoiceChannelId);
	const isConnectedRef = useRef(isConnected);

	const onTransportFailure = useCallback(() => {
		if (hasHandledTransportFailureRef.current) {
			logVoice('Transport failure already handled, skipping duplicate cleanup');
			return;
		}

		hasHandledTransportFailureRef.current = true;
		logVoice('Transport failure detected, triggering voice cleanup');

		const channelId = currentVoiceChannelIdRef.current;

		if (isConnectedRef.current && channelId !== undefined) {
			setPendingVoiceReconnectChannelId(channelId);
			useServerStore.getState().setCurrentVoiceChannelId(undefined);
		}

		voiceCleanupRef.current?.();
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

	useEffect(() => {
		remoteUserStreamsRef.current = remoteUserStreams;
		externalStreamsRef.current = externalStreams;

		const referencePipeline = micReferenceAudioPipelineRef.current;
		if (!referencePipeline) {
			return;
		}

		referencePipeline.updateStreams(
			collectPlaybackReferenceStreams(
				remoteUserStreams,
				externalStreams,
				audioVideoRefsMap.current,
				!ownVoiceState.soundMuted,
			),
		);
	}, [externalStreams, remoteUserStreams, ownVoiceState.soundMuted]);

	useEffect(() => {
		if (currentVoiceChannelId === undefined) {
			watchedExternalStreamsRef.current = {};
			return;
		}

		const currentRtpCapabilities = sendRtpCapabilities.current;

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
	}, [consume, currentChannelExternalStreams, currentVoiceChannelId, pendingStreams]);

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

	useEffect(() => {
		const handleVolumeSettingsUpdated = (event: Event) => {
			const customEvent = event as CustomEvent<TVolumeSettingsUpdatedDetail>;

			if (customEvent.detail.key !== OWN_MIC_VOLUME_KEY) {
				return;
			}

			applyMicGainVolume(customEvent.detail.volume);
		};

		window.addEventListener(VOLUME_SETTINGS_UPDATED_EVENT, handleVolumeSettingsUpdated);

		return () => {
			window.removeEventListener(VOLUME_SETTINGS_UPDATED_EVENT, handleVolumeSettingsUpdated);
		};
	}, [applyMicGainVolume]);

	const cleanupMicReferenceAudioPipeline = useCallback(async () => {
		const referencePipeline = micReferenceAudioPipelineRef.current;
		micReferenceAudioPipelineRef.current = undefined;
		micReferenceSequenceRef.current = 0;

		if (!referencePipeline) {
			return;
		}

		try {
			await referencePipeline.destroy();
		} catch (error) {
			logVoice('Failed to clean up microphone reference audio pipeline', {
				error,
			});
		}
	}, []);

	const cleanupMicAudioPipeline = useCallback(async () => {
		await cleanupMicReferenceAudioPipeline();

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
	}, [cleanupMicReferenceAudioPipeline, localAudioProducer]);

	const startMicStream = useCallback(async () => {
		try {
			logVoice('Starting microphone stream');

			await cleanupMicAudioPipeline();
			const desktopBridge = getDesktopBridge();

			const micProcessingConfig = resolveMicProcessingConfig(devices, Boolean(desktopBridge));

			// Resolve sidecar device ID best-effort before acquiring getUserMedia
			let sidecarDeviceId: string | undefined;
			if (micProcessingConfig.sidecarVoiceProcessingEnabled && desktopBridge) {
				sidecarDeviceId = await resolveSidecarDeviceId(devices.microphoneId, desktopBridge);
			}

			// Try native sidecar capture first (no getUserMedia needed)
			if (micProcessingConfig.sidecarVoiceProcessingEnabled && desktopBridge) {
				try {
					const nativePipeline = await createNativeSidecarMicCapturePipeline({
						suppressionLevel: micProcessingConfig.sidecarSuppressionLevel,
						noiseSuppression: micProcessingConfig.sidecarNoiseSuppression,
						autoGainControl: micProcessingConfig.sidecarAutoGainControl,
						echoCancellation: micProcessingConfig.sidecarEchoCancellation,
						dfnMix: micProcessingConfig.sidecarDfnMix,
						dfnAttenuationLimitDb: micProcessingConfig.sidecarDfnAttenuationLimitDb,
						dfnExperimentalAggressiveMode: micProcessingConfig.sidecarExperimentalAggressiveMode,
						dfnNoiseGateFloorDbfs: micProcessingConfig.sidecarNoiseGateFloorDbfs,
						sidecarDeviceId,
						desktopBridge,
					});

					if (nativePipeline) {
						micAudioPipelineRef.current = nativePipeline;
						let outboundStream = nativePipeline.stream;
						let outboundAudioTrack = nativePipeline.track;
						const activeVoiceFilterSessionId = nativePipeline.sessionId;

						logVoice('Microphone native capture enabled', {
							backend: nativePipeline.backend,
							suppressionLevel: micProcessingConfig.sidecarSuppressionLevel,
						});

						if (micProcessingConfig.sidecarEchoCancellation && activeVoiceFilterSessionId) {
							const referencePipeline = await createMicReferenceAudioPipeline({
								sampleRate: nativePipeline.sampleRate,
								channels: nativePipeline.channels,
								targetFrameSize: nativePipeline.framesPerBuffer,
								onFrame: (samples, frameCount) => {
									desktopBridge.pushVoiceFilterReferencePcmFrame({
										sessionId: activeVoiceFilterSessionId,
										sequence: micReferenceSequenceRef.current,
										sampleRate: nativePipeline.sampleRate,
										channels: nativePipeline.channels,
										frameCount,
										timestampMs: nowSteadyEpochMs(),
										pcm: samples,
										protocolVersion: 1,
									});
									micReferenceSequenceRef.current += 1;
								},
							});

							if (referencePipeline) {
								micReferenceAudioPipelineRef.current = referencePipeline;
								referencePipeline.updateStreams(
									collectPlaybackReferenceStreams(
										remoteUserStreamsRef.current,
										externalStreamsRef.current,
										audioVideoRefsMap.current,
										!ownVoiceState.soundMuted,
									),
								);
							}
						}

						const micGainPipeline = await createMicGainPipeline(outboundStream, getStoredVolume(OWN_MIC_VOLUME_KEY));

						if (micGainPipeline) {
							micGainPipelineRef.current = micGainPipeline;
							outboundStream = micGainPipeline.stream;
							outboundAudioTrack = micGainPipeline.track;
						}

						setLocalAudioStream(outboundStream);
						outboundAudioTrack.enabled = !ownVoiceState.micMuted;

						logVoice('Obtained audio track (native capture)', {
							audioTrack: outboundAudioTrack,
						});

						const audioProducer = await producerTransport.current?.produce({
							track: outboundAudioTrack,
							encodings: [{ maxBitrate: AUDIO_OPUS_TARGET_BITRATE_BPS }],
							codecOptions: AUDIO_OPUS_CODEC_OPTIONS,
							appData: { kind: StreamKind.AUDIO },
						});
						localAudioProducer.current = audioProducer;

						logVoice('Microphone audio producer created (native capture)', {
							producer: audioProducer,
						});

						audioProducer?.on('@close', async () => {
							logVoice('Audio producer closed');
							if (localAudioProducer.current === audioProducer) {
								localAudioProducer.current = undefined;
							}
							const trpc = getTRPCClient();
							try {
								await trpc.voice.closeProducer.mutate({
									kind: StreamKind.AUDIO,
								});
							} catch (error) {
								logVoice('Error closing audio producer', { error });
							}
						});

						outboundAudioTrack.onended = () => {
							logVoice('Audio track ended, cleaning up microphone');
							void cleanupMicAudioPipeline();
							audioProducer?.close();
							setLocalAudioStream((currentStream) => {
								return currentStream === outboundStream ? undefined : currentStream;
							});
						};

						return;
					}
				} catch (nativeError) {
					logVoice('Native sidecar mic-capture failed, falling back to getUserMedia', { nativeError });
				}
			}

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

			const rawAudioTrack = stream.getAudioTracks()[0];

			if (rawAudioTrack) {
				let outboundStream = stream;
				let outboundAudioTrack = rawAudioTrack;
				let activeVoiceFilterSessionId: string | undefined;
				try {
					const micAudioPipeline = await createMicAudioProcessingPipeline({
						inputTrack: rawAudioTrack,
						enabled: micProcessingConfig.sidecarVoiceProcessingEnabled,
						wasmNoiseSuppressionEnabled: micProcessingConfig.wasmNoiseSuppressionEnabled,
						suppressionLevel: micProcessingConfig.sidecarSuppressionLevel,
						noiseSuppression: micProcessingConfig.sidecarNoiseSuppression,
						autoGainControl: micProcessingConfig.sidecarAutoGainControl,
						echoCancellation: micProcessingConfig.sidecarEchoCancellation,
						dfnMix: micProcessingConfig.sidecarDfnMix,
						dfnAttenuationLimitDb: micProcessingConfig.sidecarDfnAttenuationLimitDb,
						dfnExperimentalAggressiveMode: micProcessingConfig.sidecarExperimentalAggressiveMode,
						dfnNoiseGateFloorDbfs: micProcessingConfig.sidecarNoiseGateFloorDbfs,
						onWasmError: (error) => {
							logVoice('Browser WASM voice filter runtime error', { error });
						},
					});

					if (micAudioPipeline) {
						micAudioPipelineRef.current = micAudioPipeline;
						outboundStream = micAudioPipeline.stream;
						outboundAudioTrack = micAudioPipeline.track;
						activeVoiceFilterSessionId = micAudioPipeline.sessionId;
						logVoice('Microphone voice filter enabled', {
							backend: micAudioPipeline.backend,
							suppressionLevel: micProcessingConfig.sidecarSuppressionLevel,
						});

						if (
							micProcessingConfig.sidecarEchoCancellation &&
							desktopBridge &&
							activeVoiceFilterSessionId &&
							micAudioPipeline.backend === 'sidecar-native'
						) {
							const referencePipeline = await createMicReferenceAudioPipeline({
								sampleRate: micAudioPipeline.sampleRate,
								channels: micAudioPipeline.channels,
								targetFrameSize: micAudioPipeline.framesPerBuffer,
								onFrame: (samples, frameCount) => {
									desktopBridge.pushVoiceFilterReferencePcmFrame({
										sessionId: activeVoiceFilterSessionId!,
										sequence: micReferenceSequenceRef.current,
										sampleRate: micAudioPipeline.sampleRate,
										channels: micAudioPipeline.channels,
										frameCount,
										timestampMs: nowSteadyEpochMs(),
										pcm: samples,
										protocolVersion: 1,
									});
									micReferenceSequenceRef.current += 1;
								},
							});

							if (referencePipeline) {
								micReferenceAudioPipelineRef.current = referencePipeline;
								referencePipeline.updateStreams(
									collectPlaybackReferenceStreams(
										remoteUserStreamsRef.current,
										externalStreamsRef.current,
										audioVideoRefsMap.current,
										!ownVoiceState.soundMuted,
									),
								);
								logVoice('Voice filter playback reference pipeline enabled', {
									sessionId: activeVoiceFilterSessionId,
									channels: micAudioPipeline.channels,
									sampleRate: micAudioPipeline.sampleRate,
								});
							} else {
								logVoice('Playback reference pipeline unavailable; sidecar AEC inactive');
							}
						}
					} else {
						micAudioPipelineRef.current = undefined;
						await cleanupMicReferenceAudioPipeline();
					}
				} catch (error) {
					micAudioPipelineRef.current = undefined;
					await cleanupMicReferenceAudioPipeline();
					logVoice('Failed to initialize microphone voice filter, using raw mic', {
						error,
					});

					if (
						micProcessingConfig.sidecarVoiceProcessingEnabled &&
						(micProcessingConfig.sidecarAutoGainControl || micProcessingConfig.sidecarNoiseSuppression)
					) {
						try {
							const fallbackStream = await navigator.mediaDevices.getUserMedia({
								audio: {
									...micConstraints,
									autoGainControl: micProcessingConfig.sidecarAutoGainControl,
									noiseSuppression: micProcessingConfig.sidecarNoiseSuppression,
								},
								video: false,
							});
							stream.getTracks().forEach((track) => {
								track.stop();
							});
							rawMicStreamRef.current = fallbackStream;

							const fallbackTrack = fallbackStream.getAudioTracks()[0];
							if (fallbackTrack) {
								outboundStream = fallbackStream;
								outboundAudioTrack = fallbackTrack;
								logVoice('Restored browser microphone processing after sidecar initialization failure');
							}
						} catch (fallbackError) {
							logVoice('Failed to restore browser microphone processing after sidecar failure', { fallbackError });
						}
					}
				}

				const micGainPipeline = await createMicGainPipeline(outboundStream, getStoredVolume(OWN_MIC_VOLUME_KEY));

				if (micGainPipeline) {
					micGainPipelineRef.current = micGainPipeline;
					outboundStream = micGainPipeline.stream;
					outboundAudioTrack = micGainPipeline.track;
				}

				setLocalAudioStream(outboundStream);
				outboundAudioTrack.enabled = !ownVoiceState.micMuted;

				logVoice('Obtained audio track', { audioTrack: outboundAudioTrack });

				const audioProducer = await producerTransport.current?.produce({
					track: outboundAudioTrack,
					encodings: [{ maxBitrate: AUDIO_OPUS_TARGET_BITRATE_BPS }],
					codecOptions: AUDIO_OPUS_CODEC_OPTIONS,
					appData: { kind: StreamKind.AUDIO },
				});
				localAudioProducer.current = audioProducer;

				logVoice('Microphone audio producer created', {
					producer: audioProducer,
				});

				audioProducer?.on('@close', async () => {
					logVoice('Audio producer closed');

					if (localAudioProducer.current === audioProducer) {
						localAudioProducer.current = undefined;
					}

					const trpc = getTRPCClient();

					try {
						await trpc.voice.closeProducer.mutate({
							kind: StreamKind.AUDIO,
						});
					} catch (error) {
						logVoice('Error closing audio producer', { error });
					}
				});

				outboundAudioTrack.onended = () => {
					logVoice('Audio track ended, cleaning up microphone');

					void cleanupMicAudioPipeline();
					audioProducer?.close();

					setLocalAudioStream((currentStream) => {
						return currentStream === outboundStream ? undefined : currentStream;
					});
				};
			} else {
				throw new Error('Failed to obtain audio track from microphone');
			}
		} catch (error) {
			logVoice('Error starting microphone stream', { error });
			await cleanupMicAudioPipeline();
			setLocalAudioStream(undefined);
		}
	}, [
		cleanupMicAudioPipeline,
		cleanupMicReferenceAudioPipeline,
		producerTransport,
		setLocalAudioStream,
		localAudioProducer,
		devices,
		ownVoiceState.micMuted,
		ownVoiceState.soundMuted,
	]);

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

			setLocalVideoStream(stream);

			const videoTrack = stream.getVideoTracks()[0];

			if (videoTrack) {
				logVoice('Obtained video track', { videoTrack });

				const preferredVideoCodec = resolvePreferredVideoCodec(sendRtpCapabilities.current, devices.videoCodec);

				if (devices.videoCodec !== VideoCodecPreference.AUTO && !preferredVideoCodec) {
					logVoice('Preferred webcam codec unavailable, falling back to auto', {
						preferredCodec: devices.videoCodec,
					});
				}

				const webcamTrackSettings = videoTrack.getSettings();
				const webcamBitratePolicy = getVideoBitratePolicy({
					profile: 'camera',
					width: webcamTrackSettings.width ?? requestedWebcamResolution.width,
					height: webcamTrackSettings.height ?? requestedWebcamResolution.height,
					frameRate: webcamTrackSettings.frameRate ?? devices.webcamFramerate,
					codecMimeType: preferredVideoCodec?.mimeType,
				});

				const videoProducer = await producerTransport.current?.produce({
					track: videoTrack,
					encodings: [{ maxBitrate: webcamBitratePolicy.maxKbps * 1000 }],
					codec: preferredVideoCodec,
					codecOptions: {
						videoGoogleStartBitrate: webcamBitratePolicy.startKbps,
					},
					appData: { kind: StreamKind.VIDEO },
				});
				localVideoProducer.current = videoProducer;

				logVoice('Webcam video producer created', {
					producer: videoProducer,
				});

				videoProducer?.on('@close', async () => {
					logVoice('Video producer closed');

					if (localVideoProducer.current === videoProducer) {
						localVideoProducer.current = undefined;
					}

					const trpc = getTRPCClient();

					try {
						await trpc.voice.closeProducer.mutate({
							kind: StreamKind.VIDEO,
						});
					} catch (error) {
						logVoice('Error closing video producer', { error });
					}
				});

				videoTrack.onended = () => {
					logVoice('Video track ended, cleaning up webcam');

					stream.getVideoTracks().forEach((track) => {
						track.stop();
					});
					videoProducer?.close();

					setLocalVideoStream((currentStream) => {
						return currentStream === stream ? undefined : currentStream;
					});
				};
			} else {
				throw new Error('Failed to obtain video track from webcam');
			}
		} catch (error) {
			logVoice('Error starting webcam stream', { error });
			throw error;
		}
	}, [
		setLocalVideoStream,
		localVideoProducer,
		producerTransport,
		devices.webcamId,
		devices.webcamFramerate,
		devices.webcamResolution,
		devices.videoCodec,
	]);

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
		const desktopBridge = getDesktopBridge();

		if (!desktopBridge) {
			return null;
		}

		try {
			const [sources, capabilities] = await Promise.all([
				desktopBridge.listShareSources(),
				desktopBridge.getCapabilities(),
			]);

			if (sources.length === 0) {
				toast.error('No windows or screens were detected for sharing.');
				return null;
			}

			return requestScreenShareSelectionDialog({
				sources,
				capabilities,
				defaultAudioMode: devices.screenAudioMode,
			});
		} catch (error) {
			logVoice('Failed to open desktop screen share picker', { error });
			toast.error('Failed to load shareable sources.');
			return null;
		}
	}, [devices.screenAudioMode]);

	const startScreenShareStream = useCallback(
		async (desktopSelection?: TDesktopScreenShareSelection) => {
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

				if (desktopBridge && desktopSelection && audioMode === ScreenAudioMode.APP) {
					try {
						logVoice('Starting per-app sidecar capture', {
							sourceId: desktopSelection.sourceId,
							appAudioTargetId: desktopSelection.appAudioTargetId,
						});
						const appAudioSession = await desktopBridge.startAppAudioCapture({
							sourceId: desktopSelection.sourceId,
							appAudioTargetId: desktopSelection.appAudioTargetId,
						});
						logVoice('Per-app sidecar capture started', {
							sessionId: appAudioSession.sessionId,
							targetId: appAudioSession.targetId,
						});
						const appAudioPipeline = await createDesktopAppAudioPipeline(appAudioSession, {
							mode: 'stable',
							logLabel: 'per-app-audio',
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

							logVoice('Per-app sidecar produced no audio frames after startup', {
								sessionId: appAudioSession.sessionId,
								targetId: appAudioSession.targetId,
							});
							toast.warning(
								'Per-app audio started but produced no audio frames. Screen video will continue without shared audio.',
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
									logVoice('Received first per-app audio frame', {
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
								logVoice('Received per-app sidecar status event', {
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
											? `Per-app audio capture ended (${statusEvent.reason}): ${statusEvent.error}`
											: `Per-app audio capture ended (${statusEvent.reason}). Screen video will continue without shared audio.`,
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
					} catch (error) {
						logVoice('Failed to start per-app sidecar audio capture', {
							error,
						});
						toast.warning('Per-app audio capture failed. Continuing without shared audio.');
						await cleanupDesktopAppAudio();
						audioMode = ScreenAudioMode.NONE;
					}
				}

				// Electron main only provides display-capture audio in system mode.
				// Requesting audio in per-app mode can abort capture startup.
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
				setLocalScreenShare(stream);

				const videoTrack = stream.getVideoTracks()[0];
				const audioTrack = stream.getAudioTracks()[0];

				if (audioMode === ScreenAudioMode.APP && audioTrack) {
					audioTrack.stop();
					stream.removeTrack(audioTrack);
					standbyDisplayAudioTrackRef.current = undefined;
					standbyDisplayAudioStreamRef.current = undefined;
				} else {
					standbyDisplayAudioTrackRef.current = undefined;
					standbyDisplayAudioStreamRef.current = undefined;
				}

				if (videoTrack) {
					logVoice('Obtained video track', { videoTrack });

					// Favor text/detail preservation for desktop/screen content.
					videoTrack.contentHint = 'detail';

					const preferredVideoCodec = resolvePreferredVideoCodec(sendRtpCapabilities.current, devices.videoCodec);

					if (devices.videoCodec !== VideoCodecPreference.AUTO && !preferredVideoCodec) {
						logVoice('Preferred screen share codec unavailable, falling back to auto', {
							preferredCodec: devices.videoCodec,
						});
					}

					const screenTrackSettings = videoTrack.getSettings();
					const screenBitratePolicy = getVideoBitratePolicy({
						profile: 'screen',
						width: screenTrackSettings.width ?? requestedScreenResolution.width,
						height: screenTrackSettings.height ?? requestedScreenResolution.height,
						frameRate: screenTrackSettings.frameRate ?? devices.screenFramerate,
						codecMimeType: preferredVideoCodec?.mimeType,
					});

					localScreenShareProducer.current = await producerTransport.current?.produce({
						track: videoTrack,
						encodings: [{ maxBitrate: screenBitratePolicy.maxKbps * 1000 }],
						codecOptions: {
							videoGoogleStartBitrate: screenBitratePolicy.startKbps,
						},
						codec: preferredVideoCodec,
						appData: { kind: StreamKind.SCREEN },
					});

					localScreenShareProducer.current?.on('@close', async () => {
						logVoice('Screen share producer closed');

						const trpc = getTRPCClient();

						try {
							await trpc.voice.closeProducer.mutate({
								kind: StreamKind.SCREEN,
							});
						} catch (error) {
							logVoice('Error closing screen share producer', { error });
						}
					});

					videoTrack.onended = () => {
						logVoice('Screen share track ended, cleaning up screen share');

						localScreenShareStream?.getTracks().forEach((track) => {
							track.stop();
						});
						localScreenShareProducer.current?.close();
						localScreenShareAudioProducer.current?.close();
						standbyDisplayAudioTrackRef.current = undefined;
						standbyDisplayAudioStreamRef.current = undefined;
						void cleanupDesktopAppAudio();

						setLocalScreenShare(undefined);
						setLocalScreenShareAudio(undefined);
					};

					if (audioMode === ScreenAudioMode.APP && appAudioPipelineRef.current?.track) {
						const appAudioTrack = appAudioPipelineRef.current.track;
						setLocalScreenShareAudio(appAudioPipelineRef.current.stream);

						localScreenShareAudioProducer.current = await producerTransport.current?.produce({
							track: appAudioTrack,
							appData: { kind: StreamKind.SCREEN_AUDIO },
						});

						appAudioTrack.onended = () => {
							localScreenShareAudioProducer.current?.close();
							localScreenShareAudioProducer.current = undefined;
							setLocalScreenShareAudio(undefined);

							void cleanupDesktopAppAudio({
								stopCapture: false,
							});
						};
					} else if (audioTrack) {
						logVoice('Obtained audio track', { audioTrack });
						setLocalScreenShareAudio(new MediaStream([audioTrack]));

						localScreenShareAudioProducer.current = await producerTransport.current?.produce({
							track: audioTrack,
							appData: { kind: StreamKind.SCREEN_AUDIO },
						});

						audioTrack.onended = () => {
							localScreenShareAudioProducer.current?.close();
							localScreenShareAudioProducer.current = undefined;
							setLocalScreenShareAudio(undefined);
						};
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
			setLocalScreenShare,
			localScreenShareProducer,
			localScreenShareAudioProducer,
			producerTransport,
			localScreenShareStream,
			setLocalScreenShareAudio,
			devices.screenAudioMode,
			devices.screenResolution,
			devices.screenFramerate,
			devices.videoCodec,
		],
	);

	const cleanup = useCallback(() => {
		logVoice('Running voice provider cleanup');

		void cleanupDesktopAppAudio();
		void cleanupMicAudioPipeline();
		stopMonitoring();
		resetStats();
		clearLocalStreams();
		clearRemoteUserStreams();
		clearExternalStreams();
		cleanupTransports();
		sendRtpCapabilities.current = null;

		setConnectionStatus(ConnectionStatus.DISCONNECTED);
	}, [
		stopMonitoring,
		resetStats,
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

			try {
				setLoading(true);
				setConnectionStatus(ConnectionStatus.CONNECTING);

				if (opts?.playJoinSound !== false) {
					playSound(SoundType.OWN_USER_JOINED_VOICE_CHANNEL);
				}

				routerRtpCapabilities.current = incomingRouterRtpCapabilities;

				const device = new Device();

				await device.load({
					routerRtpCapabilities: incomingRouterRtpCapabilities,
				});
				sendRtpCapabilities.current = device.rtpCapabilities;

				await Promise.all([
					createProducerTransport(device, opts?.producerTransportParams),
					createConsumerTransport(device, opts?.consumerTransportParams),
				]);
				await Promise.all([
					consumeExistingProducers(device.rtpCapabilities, undefined, opts?.existingProducers),
					startMicStream(),
				]);

				startMonitoring(producerTransport.current, consumerTransport.current);
				setConnectionStatus(ConnectionStatus.CONNECTED);
				setLoading(false);
			} catch (error) {
				logVoice('Error initializing voice provider', { error });

				setConnectionStatus(ConnectionStatus.FAILED);
				setLoading(false);

				throw error;
			}
		},
		[
			cleanup,
			createProducerTransport,
			createConsumerTransport,
			consumeExistingProducers,
			startMicStream,
			startMonitoring,
			producerTransport,
			consumerTransport,
		],
	);

	const { setMicMuted, toggleMic, toggleSound, toggleWebcam, toggleScreenShare } = useVoiceControls({
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
	}, [channelCan, currentVoiceChannelId, isConnected]);

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
		rtpCapabilities: sendRtpCapabilities.current,
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: voiceReconnectRetryToken is a trigger dep — bumped to force reconnect retry
	useEffect(() => {
		if (!isConnected) {
			return;
		}

		if (currentVoiceChannelId !== undefined) {
			if (connectionStatus === ConnectionStatus.CONNECTED) {
				clearPendingVoiceReconnectChannelId();
			}

			return;
		}

		if (reconnectingVoiceRef.current) {
			return;
		}

		const pendingChannelId = getPendingVoiceReconnectChannelId();

		if (pendingChannelId === undefined) {
			return;
		}

		reconnectingVoiceGenerationRef.current += 1;
		const reconnectGeneration = reconnectingVoiceGenerationRef.current;
		reconnectingVoiceRef.current = true;
		let cancelled = false;
		let retryTimeoutId: number | undefined;
		const scheduleVoiceReconnectRetry = () => {
			if (cancelled) {
				return;
			}

			if (getPendingVoiceReconnectRetryCount() < MAX_VOICE_REJOIN_RETRIES) {
				incrementPendingVoiceReconnectRetryCount();
				retryTimeoutId = window.setTimeout(() => {
					setVoiceReconnectRetryToken((value) => value + 1);
				}, VOICE_REJOIN_RETRY_DELAY_MS);
				return;
			}

			clearPendingVoiceReconnectChannelId();
			toast.error('Failed to restore voice connection after multiple attempts');
		};

		void (async () => {
			try {
				const joinResult = await joinVoice(pendingChannelId, {
					silent: true,
				});

				if (joinResult.kind === 'non-retriable-failure') {
					clearPendingVoiceReconnectChannelId();
					return;
				}

				if (joinResult.kind !== 'joined') {
					scheduleVoiceReconnectRetry();
					return;
				}

				await init(joinResult.routerRtpCapabilities, pendingChannelId, {
					producerTransportParams: joinResult.producerTransportParams,
					consumerTransportParams: joinResult.consumerTransportParams,
					existingProducers: joinResult.existingProducers,
					playJoinSound: false,
				});
				clearPendingVoiceReconnectChannelId();
			} catch (error) {
				logVoice('Failed to auto-rejoin previous voice channel', { error });
				await leaveVoiceSilently();
				scheduleVoiceReconnectRetry();
			} finally {
				if (reconnectingVoiceGenerationRef.current === reconnectGeneration) {
					reconnectingVoiceRef.current = false;
				}
			}
		})();

		return () => {
			cancelled = true;

			if (retryTimeoutId !== undefined) {
				window.clearTimeout(retryTimeoutId);
			}
		};
	}, [connectionStatus, currentVoiceChannelId, init, isConnected, voiceReconnectRetryToken]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: must be mount-only — cleanup recreates on inner dep changes which would tear down voice
	useEffect(() => {
		return () => {
			logVoice('Voice provider unmounting, cleaning up resources');
			cleanup();
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
		</VoiceProviderContext.Provider>
	);
});

export { VoiceProvider, VoiceProviderContext };
