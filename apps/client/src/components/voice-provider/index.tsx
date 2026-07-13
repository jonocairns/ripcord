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
import {
	createContext,
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
import { channelByIdSelector } from '@/features/server/channels/selectors';
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
	type TVoiceSessionCommand,
	type TVoiceSessionConnectionStatus,
	type TWatchedExternalStreamsSnapshot,
	type TWatchedRemoteStreamsSnapshot,
} from '@/features/server/voice/voice-session-machine';
import {
	dispatchVoiceSession,
	getVoiceSessionState,
	subscribeVoiceSession,
} from '@/features/server/voice/voice-session-store';
import { logDebug, logVoice, reportError, traceSentrySpan } from '@/helpers/browser-logger';
import { getResWidthHeight } from '@/helpers/get-res-with-height';
import { getTrpcErrorData } from '@/helpers/trpc-error-data';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge, isDesktopRuntime } from '@/runtime/desktop-bridge';
import { normalizeDesktopCapabilities } from '@/runtime/desktop-capabilities';
import {
	ScreenAudioMode,
	type TAppAudioSession,
	type TAppAudioStatusEvent,
	type TDesktopBridge,
	type TDesktopCapabilities,
	type TDesktopPushKeybindEvent,
	type TDesktopScreenShareSelection,
	type TStartAppAudioCaptureInput,
} from '@/runtime/types';
import { type TDeviceSettings, VideoCodecPreference } from '@/types';
import { useDevices } from '../devices-provider/hooks/use-devices';
import { createAudioContextWithSampleRateFallback, resolveAudioContextClass } from './audio-context';
import { didDefaultInputDeviceChange, resolveDefaultInputGroupId } from './default-input-device';
import { createDesktopAppAudioPipeline, type TDesktopAppAudioPipeline } from './desktop-app-audio';
import { FloatingPinnedCard } from './floating-pinned-card';
import {
	createRemoteMediaConsumeStartPublication,
	type TRemoteMediaConsumeStartPublication,
} from './hooks/remote-media-consume-start-publication';
import { useRemoteMediaSubscriptions } from './hooks/remote-media-subscriptions';
import {
	claimVoiceSessionExecution,
	createVoiceSessionExecutionOwnership,
	invalidateVoiceSessionExecution,
	VoiceSessionExecutionSupersededError,
} from './hooks/session-execution-ownership';
import { useLocalStreams } from './hooks/use-local-streams';
import { getPendingStreamKey, type TExternalStreamTrackPresence } from './hooks/use-pending-streams';
import { useRemoteMediaConsumeRunner } from './hooks/use-remote-media-consume-runner';
import { useRemoteMediaRepairRunner } from './hooks/use-remote-media-repair-runner';
import { useRemoteStreams } from './hooks/use-remote-streams';
import { useScreenShareQualityGuard } from './hooks/use-screen-share-quality-guard';
import { type TransportStatsStore, useTransportStats } from './hooks/use-transport-stats';
import { useTransports } from './hooks/use-transports';
import { useVoiceControls } from './hooks/use-voice-controls';
import { useVoiceEvents } from './hooks/use-voice-events';
import { useVoiceSessionExecutor } from './hooks/use-voice-session-executor';
import {
	type ActivityBroadcastState,
	resolveActivityBroadcast,
	startLocalVoiceActivityMonitor,
} from './local-voice-activity';
import { createMicAudioProcessingPipeline, type TMicAudioProcessingPipeline } from './mic-audio-processing';
import {
	createMicrophonePipelineController,
	type TMicrophonePipelineController,
	type TMicrophonePreparedPipeline,
} from './microphone-pipeline-controller';
import { prewarmVoiceEngines } from './prewarm';
import {
	clearHeldPushMicState,
	resolveHeldPushMicTarget,
	resolvePushMicState,
	type TPushMicState,
	updatePushMicStateForKeyEvent,
} from './push-mic-state';
import { getVideoBitratePolicy, type TVideoBitrateCodec } from './video-bitrate-policy';
import { VIDEO_DEGRADATION_PREFERENCE } from './video-encoding-constants';
import { createVoiceActivityStore, type VoiceActivityStore } from './voice-activity';
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

type TAppAudioPublishIntent = {
	audioMode: ScreenAudioMode.APP | ScreenAudioMode.SYSTEM;
	captureInput: TStartAppAudioCaptureInput;
};

type TDesktopAppAudioWorkletStartResult =
	| { kind: 'published'; displayAudioTrack: undefined }
	| { kind: 'display-fallback'; displayAudioTrack: MediaStreamTrack }
	| { kind: 'none'; displayAudioTrack: undefined };

type TVoiceBootstrapResult = {
	routerRtpCapabilities: RtpCapabilities;
	channelUsers: Array<{ userId: number; state: TVoiceUserState }>;
	existingProducers?: TRemoteProducerIds;
	producerTransportParams?: TTransportParams;
	consumerTransportParams?: TTransportParams;
};

type TRepublishedLocalMediaState = Partial<Pick<TVoiceUserState, 'webcamEnabled' | 'sharingScreen'>>;

type TLocalMediaRepublishPlan = {
	tasks: Promise<void>[];
	state: TRepublishedLocalMediaState;
};

type TInitResult = {
	republishedLocalMediaState: TRepublishedLocalMediaState;
};

export type { AudioVideoRefs };

const createEmptyAudioVideoRefs = (): AudioVideoRefs => ({
	videoRef: { current: null },
	audioRef: { current: null },
	screenShareRef: { current: null },
	screenShareAudioRef: { current: null },
	externalAudioRef: { current: null },
	externalVideoRef: { current: null },
});

type TConnectionStatus = TVoiceSessionConnectionStatus;

const getVoiceSessionConnectionStatusSnapshot = (): TConnectionStatus =>
	selectVoiceSessionConnectionStatus(getVoiceSessionState());

const subscribeVoiceSessionConnectionStatus = (onStoreChange: () => void): (() => void) =>
	subscribeVoiceSession(onStoreChange);

const VIDEO_CODEC_MIME_TYPE_BY_PREFERENCE: Record<string, string> = {
	[VideoCodecPreference.VP8]: 'video/VP8',
	[VideoCodecPreference.VP9]: 'video/VP9',
	[VideoCodecPreference.H264]: 'video/H264',
};
const DEFAULT_AUDIO_OPUS_TARGET_BITRATE_BPS = 96_000;
// Desktop/game audio is music-grade, full-band content (not voice), so it gets
// stereo, high-bitrate opus with FEC on and DTX off — DTX gates "silence" and
// audibly clips sustained music.
const SCREEN_SHARE_AUDIO_TARGET_BITRATE_BPS = 256_000;

// Temporal SVC for video producers: one spatial layer (single encode, single
// resolution) split into three temporal layers (~T0/T1/T2 frame-rate tiers).
// This is the cheap kind of layering — reference-structure bookkeeping, not
// re-encoding — so there's no meaningful streamer CPU cost. It lets the SFU
// shed a temporal layer per slow viewer (graceful frame-rate drop instead of a
// frozen/stuttering stream + PLI storms), and reinforces the degradation
// preference under bitrate pressure. No maxBitrate is set, preserving the
// "let congestion control settle the rate" policy. Best on VP9; hardware H264
// may fall back to a single layer (L1T1), which is harmless.
const VIDEO_SCALABILITY_MODE = 'L1T3';

type TVideoProducerEncoding = {
	scalabilityMode?: string;
	maxBitrate?: number;
};

const createVideoProducerEncodings = (): TVideoProducerEncoding[] => {
	return [{ scalabilityMode: VIDEO_SCALABILITY_MODE }];
};

// Map the resolved/effective send codec to a bitrate-policy codec so the
// max-bitrate ceiling can be scaled per codec. When no codec is resolved (AUTO
// where mediasoup-client picks a default internally) we fall back to 'auto'.
const getBitrateCodecFromMimeType = (codec: RtpCodecCapability | undefined): TVideoBitrateCodec => {
	const mimeType = codec?.mimeType.toLowerCase();

	if (mimeType === 'video/h264') return 'h264';
	if (mimeType === 'video/vp8') return 'vp8';
	if (mimeType === 'video/vp9') return 'vp9';

	return 'auto';
};

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

const findVideoCodecByMime = (
	rtpCapabilities: RtpCapabilities | null,
	mimeType: string,
): RtpCodecCapability | undefined => {
	const lowerMimeType = mimeType.toLowerCase();

	return (rtpCapabilities?.codecs ?? []).find((codec) => {
		return codec.mimeType.toLowerCase() === lowerMimeType;
	});
};

type TScreenShareEncodeParams = {
	width: number;
	height: number;
	framerate: number;
	bitrate: number;
};

// Resolve the screen share send codec.
// - AUTO: prefer H264; it has broad hardware-encoder support and is universally
//   decodable by viewers. Without this, mediasoup-client's default pick is the
//   first negotiated codec (VP8), silently landing software encoding on
//   demanding shares.
// - Explicit VP9/VP8/H264: use as chosen; the caller knowingly accepts the
//   (often software-encoded) CPU trade-off for VP9/VP8.
const resolveScreenShareVideoCodec = (
	rtpCapabilities: RtpCapabilities | null,
	preference: VideoCodecPreference,
	encodeParams: TScreenShareEncodeParams,
): RtpCodecCapability | undefined => {
	const h264Codec = findVideoCodecByMime(rtpCapabilities, 'video/H264');

	if (preference === VideoCodecPreference.AUTO) {
		if (!h264Codec) {
			logVoice('H264 screen share codec unavailable for auto selection, falling back to mediasoup default codec', {
				...encodeParams,
			});
		}

		return h264Codec;
	}

	return resolvePreferredVideoCodec(rtpCapabilities, preference);
};

const applyVideoDegradationPreference = async (sender: RTCRtpSender | undefined, label: string): Promise<void> => {
	if (!sender) {
		logVoice('RTCRtpSender unavailable, skipping degradationPreference override', { label });
		return;
	}

	try {
		// setParameters must be passed the object from the immediately preceding
		// getParameters — they're coupled by its transactionId. Keep this read /
		// modify / write atomic: any other setParameters landing on this sender
		// in between would invalidate the transactionId and reject with
		// InvalidStateError. A future concurrent path (e.g. simulcast layer
		// toggling) must serialise against this, not interleave.
		const params = sender.getParameters();

		if (params.degradationPreference === VIDEO_DEGRADATION_PREFERENCE) {
			return;
		}

		params.degradationPreference = VIDEO_DEGRADATION_PREFERENCE;
		await sender.setParameters(params);
	} catch (error) {
		logVoice('Failed to set degradationPreference', { label, error });
	}
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

// Debounce the burst of `devicechange` events the OS emits while a driver
// settles before we re-check whether the system default input moved. The window
// also gives Chromium's synthetic "default" entry time to repoint to the new
// physical input before the first retry below.
const DEFAULT_INPUT_DEVICE_CHANGE_DEBOUNCE_MS = 500;
const DEFAULT_INPUT_DEVICE_CHANGE_RETRY_INTERVAL_MS = 250;
const DEFAULT_INPUT_DEVICE_CHANGE_RETRY_WINDOW_MS = 1500;

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

type TChannelExternalStreams = {
	[streamId: number]: TExternalStream;
};

const EMPTY_CHANNEL_EXTERNAL_STREAMS: TChannelExternalStreams = {};

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
			outputTrack.stop();

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
	connectionStatus: TConnectionStatus;
	audioVideoRefsMap: Map<number, AudioVideoRefs>;
	ownVoiceState: TVoiceUserState;
	getOrCreateRefs: (remoteId: number) => AudioVideoRefs;
	acceptStream: (remoteId: number, kind: StreamKind) => void;
	retryRemoteMedia: (remoteId: number, kind: StreamKind) => void;
	stopWatchingStream: (remoteId: number, kind: StreamKind) => void;
	init: (
		routerRtpCapabilities: RtpCapabilities,
		channelId: number,
		opts?: {
			producerTransportParams?: TTransportParams;
			consumerTransportParams?: TTransportParams;
			existingProducers?: TRemoteProducerIds;
			preserveLocalMedia?: boolean;
		},
	) => Promise<TInitResult>;
} & Pick<
	ReturnType<typeof useLocalStreams>,
	'localAudioStream' | 'localVideoStream' | 'localScreenShareStream' | 'localScreenShareAudioStream'
> &
	Pick<ReturnType<typeof useRemoteStreams>, 'remoteUserStreams' | 'externalStreams'> &
	Pick<
		ReturnType<typeof useRemoteMediaSubscriptions>,
		'pendingStreams' | 'remoteMediaSubscriptions' | 'visibleRemoteMedia'
	> &
	ReturnType<typeof useVoiceControls>;

const VoiceProviderContext = createContext<TVoiceProvider>({
	loading: false,
	connectionStatus: 'disconnected',
	audioVideoRefsMap: new Map(),
	getOrCreateRefs: () => createEmptyAudioVideoRefs(),
	acceptStream: () => undefined,
	retryRemoteMedia: () => undefined,
	stopWatchingStream: () => undefined,
	init: () => Promise.resolve({ republishedLocalMediaState: {} }),
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
	remoteMediaSubscriptions: new Map(),
	visibleRemoteMedia: [],
});

const VoiceActivityContext = createContext<VoiceActivityStore | null>(null);

// Transport stats update at 1 Hz for the whole voice session. They live in a
// dedicated subscribe/snapshot store (separate from VoiceProviderContext) so
// only the components that display them re-render on each sample.
const TransportStatsContext = createContext<TransportStatsStore | null>(null);

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

const isAuthDenialError = (error: unknown): boolean => {
	const code = getTrpcErrorData(error)?.code;

	return code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
};

// Stage 1 native app-audio RTP ingest defaults off. Desktop users can opt in
// through device settings; the build/localStorage switches remain for smoke
// testing packaged builds without changing saved settings.
const isNativeAppAudioIngestEnabled = (settingsEnabled: boolean): boolean => {
	try {
		const override = globalThis.localStorage?.getItem('voice.nativeAppAudio');

		if (override === 'true') return true;
		if (override === 'false') return false;
	} catch {
		// localStorage may be unavailable; fall through to the build-time flag.
	}

	return settingsEnabled || import.meta.env.VITE_VOICE_NATIVE_APP_AUDIO === 'true';
};

const createReconnectAttemptId = (): string => {
	const randomUUID = globalThis.crypto?.randomUUID;

	if (typeof randomUUID === 'function') {
		return randomUUID.call(globalThis.crypto);
	}

	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const VoiceProvider = memo(({ children }: TVoiceProviderProps) => {
	const [loading, setLoading] = useState(false);
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
	const appAudioPipelineRef = useRef<TDesktopAppAudioPipeline | undefined>(undefined);
	const appAudioSessionRef = useRef<TAppAudioSession | undefined>(undefined);
	const appAudioPublishIntentRef = useRef<TAppAudioPublishIntent | undefined>(undefined);
	// True while native RTP ingest is the active SCREEN_AUDIO path (PCM is encoded
	// and sent from the desktop main process, not the renderer worklet). Drives
	// native-specific teardown in cleanupDesktopAppAudio.
	const nativeAppAudioIngestActiveRef = useRef(false);
	// Monotonic token for native ingest attempts. Each startNativeAppAudioIngest
	// claims the next value; a stale attempt's teardown checks it owns the current
	// token before touching shared/global state (the singleton RTP sender and the
	// session/active refs), so an in-flight attempt that settles after a newer one
	// has started cannot stop the newer sender or wipe its session.
	const nativeAppAudioIngestGenerationRef = useRef(0);
	const removeAppAudioFrameSubscriptionRef = useRef<(() => void) | undefined>(undefined);
	const removeAppAudioStatusSubscriptionRef = useRef<(() => void) | undefined>(undefined);
	const appAudioStartupTimeoutRef = useRef<number | ReturnType<typeof setTimeout> | undefined>(undefined);
	const standbyDisplayAudioTrackRef = useRef<MediaStreamTrack | undefined>(undefined);
	const standbyDisplayAudioStreamRef = useRef<MediaStream | undefined>(undefined);
	// Last onTrackEnded handler passed to publishScreenShareTrack. Transport
	// recovery reuses it so stop-sync side effects survive a producer restart.
	const screenShareTrackEndedHandlerRef = useRef<(() => void | Promise<void>) | undefined>(undefined);
	const isPushToTalkHeldRef = useRef(false);
	const isPushToMuteHeldRef = useRef(false);
	const micMutedBeforePushRef = useRef<boolean | undefined>(undefined);
	const pushReleaseTimersRef = useRef<{ talk?: ReturnType<typeof setTimeout>; mute?: ReturnType<typeof setTimeout> }>(
		{},
	);
	const pushReleaseDelayMsRef = useLatestRef(devices.pushReleaseDelayMs);
	const previousDevicesRef = useRef<TDeviceSettings | undefined>(undefined);
	const voiceActivityStoreRef = useRef(createVoiceActivityStore());
	const micVolumeRestartPromiseRef = useRef<Promise<void> | undefined>(undefined);
	const micPipelineMutexRef = useRef<Promise<void>>(Promise.resolve());
	const sessionExecutionOwnershipRef = useRef(createVoiceSessionExecutionOwnership());
	const startMicStreamRef = useRef<(() => Promise<void>) | undefined>(undefined);

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
		refreshPendingStreamAges,
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

	const {
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

	const localAudioStreamRef = useLatestRef(localAudioStream);
	const localVideoStreamRef = useLatestRef(localVideoStream);
	const localScreenShareStreamRef = useLatestRef(localScreenShareStream);
	const localScreenShareAudioStreamRef = useLatestRef(localScreenShareAudioStream);

	const voiceCleanupRef = useRef<(() => void) | undefined>(undefined);
	const hasHandledTransportFailureRef = useRef(false);
	const currentVoiceChannelIdRef = useLatestRef(currentVoiceChannelId);
	const isConnectedRef = useLatestRef(isConnected);
	const ownUserIdRef = useLatestRef(ownUserId);
	const voiceSessionReconnectNonceRef = useLatestRef(voiceSessionReconnectNonce);

	const onTransportFailure = useCallback(() => {
		if (hasHandledTransportFailureRef.current) {
			logVoice('Transport failure already handled, skipping duplicate cleanup');
			return;
		}

		hasHandledTransportFailureRef.current = true;
		logVoice('Transport failure detected');

		const channelId = currentVoiceChannelIdRef.current;
		if (!isConnectedRef.current || channelId === undefined) {
			hasHandledTransportFailureRef.current = false;
			return;
		}

		const commands = dispatchVoiceSession({
			type: 'TransportFailed',
			channelId,
			nonce: voiceSessionReconnectNonceRef.current,
		});

		if (commands.length === 0 && getVoiceSessionState().phase.phase !== 'rebuilding') {
			hasHandledTransportFailureRef.current = false;
		}
	}, []);

	const {
		producerTransport,
		consumerTransport,
		createProducerTransport,
		createConsumerTransport,
		consume,
		consumeExistingProducers,
		closeConsumer,
		cleanupTransports,
		getActiveConsumerProducerId,
		stopWatchingStream,
	} = useTransports({
		addExternalStreamTrack,
		removeExternalStreamTrack,
		addRemoteUserStream,
		removeRemoteUserStream,
		addPendingStream,
		clearAllPendingStreams,
		reconcilePendingStreams,
		markWatchStopped,
		markConsumeStarted: publishRemoteMediaConsumeStarted,
		markConsumeSucceeded,
		markConsumeFailed,
		markConsumerClosed,
		isProducerCurrent: isRemoteMediaProducerCurrent,
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
			{ producerRef: localScreenShareProducer, label: 'Screen share' },
			{ producerRef: localVideoProducer, label: 'Webcam' },
		];

		for (const { producerRef, label } of producers) {
			const sender = producerRef.current?.rtpSender;

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
	}, [localScreenShareProducer, localVideoProducer]);

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

	// Updates the own ring instantly from the local fast-path and broadcasts the
	// transition so remote peers light up our ring without waiting on the
	// server's 250ms audio observer. A monotonic sequence number lets the server
	// drop reordered fire-and-forget mutations — a late `false` must never
	// clobber a newer `true`. The broadcast state is scoped to the active audio
	// producer so a replacement's initial `false` cannot inherit authority from
	// its predecessor. A client that can't meter locally therefore never claims
	// server-side authority.
	const voiceActivitySeqRef = useRef(0);
	const activityBroadcastStateRef = useRef<ActivityBroadcastState>({
		producerId: undefined,
		hasAnnouncedSpeaking: false,
	});

	const applyOwnLocalActivity = useCallback(
		(isSpeaking: boolean | undefined, producerId: string | undefined) => {
			if (ownUserId === undefined) {
				return;
			}

			voiceActivityStoreRef.current.setLocalUserActivity(ownUserId, isSpeaking);

			// The microphone controller supplies the producer identity it fenced the
			// activity sample against. No producer means nothing to bind to (and
			// nothing to be speaking through).
			const { broadcast, state } = resolveActivityBroadcast(isSpeaking, producerId, activityBroadcastStateRef.current);
			activityBroadcastStateRef.current = state;

			if (broadcast === undefined || producerId === undefined) {
				return;
			}

			const seq = (voiceActivitySeqRef.current += 1);

			void getTRPCClient()
				.voice.updateActivity.mutate({ isSpeaking: broadcast, seq, producerId })
				.catch(() => {});
		},
		[ownUserId],
	);
	const applyOwnLocalActivityRef = useLatestRef(applyOwnLocalActivity);

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
		refreshPendingStreamAges,
		consumeExistingProducers,
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
						'voice.channel_id': opts.channelId,
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
					attributes: {
						'voice.channel_id': channelId,
					},
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

	const microphoneControllerRef = useRef<
		TMicrophonePipelineController<Producer<AppData>, TMicAudioProcessingPipeline, TMicGainPipeline> | undefined
	>(undefined);
	if (!microphoneControllerRef.current) {
		microphoneControllerRef.current = createMicrophonePipelineController<
			Producer<AppData>,
			TMicAudioProcessingPipeline,
			TMicGainPipeline
		>({
			getUserMedia: (constraints) =>
				navigator.mediaDevices.getUserMedia({
					audio: constraints,
					video: false,
				}),
			createProcessingPipeline: ({ inputTrack, enabled, onRuntimeError }) =>
				createMicAudioProcessingPipeline({
					inputTrack,
					wasmNoiseSuppressionEnabled: enabled,
					onWasmError: onRuntimeError,
				}),
			createGainPipeline: (inputStream, volume) =>
				shouldUseMicGainPipeline(volume) ? createMicGainPipeline(inputStream, volume) : Promise.resolve(undefined),
			setGainVolume: (pipeline, volume) => {
				const nextVolume = clampVolumePercent(volume) / 100;
				const currentTime = pipeline.audioContext.currentTime;
				pipeline.gainNode.gain.cancelScheduledValues(currentTime);
				pipeline.gainNode.gain.setValueAtTime(nextVolume, currentTime);
			},
			createProducerPublicationLease: () => {
				const transport = producerTransport.current;
				if (!transport || transport.closed) {
					return undefined;
				}

				return {
					publish: (track) => {
						const audioConfig = getAudioOpusConfig(currentVoiceChannelIdRef.current);
						return transport.produce({
							track,
							encodings: [{ maxBitrate: audioConfig.maxBitrate }],
							codecOptions: audioConfig.codecOptions,
							appData: { kind: StreamKind.AUDIO },
						});
					},
					isCurrent: () => producerTransport.current === transport && !transport.closed,
				};
			},
			publishLocalStream: (stream) => {
				setLocalAudioStream(stream);
				return {
					stream,
					remove: () => {
						setLocalAudioStream((currentStream) => (currentStream === stream ? undefined : currentStream));
					},
				};
			},
			getProducerId: (producer) => producer.id,
			isProducerClosed: (producer) => producer.closed,
			closeProducer: (producer) => producer.close(),
			observeProducerClosed: (producer, onClosed) => {
				producer.on('@close', onClosed);
			},
			closeProducerOnServer: (producerId) => {
				void closeProducerOnServer(StreamKind.AUDIO, producerId);
			},
			getActivityMode: () => {
				if (!isConnectedRef.current || ownVoiceStateSelector(useServerStore.getState()).micMuted) {
					return 'inactive';
				}

				return ownUserIdRef.current === undefined ? 'unavailable' : 'monitor';
			},
			startActivityMonitor: (producer, onUpdate) =>
				startLocalVoiceActivityMonitor({
					statsProvider: producer,
					onUpdate,
				}),
			onActivityUpdate: (isSpeaking, producerId) => {
				applyOwnLocalActivityRef.current(isSpeaking, producerId);
			},
			isInVoiceChannel: () => currentVoiceChannelIdRef.current !== undefined,
			isMicMuted: () => ownVoiceStateSelector(useServerStore.getState()).micMuted,
			onRawLossRecover: () => {
				void startMicStreamRef.current?.();
			},
			onProcessingRuntimeError: (error) => {
				logVoice('Browser WASM voice filter runtime error', { error });
				toast.error('Noise suppression encountered an error. Audio will continue without noise reduction.');
			},
			setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
			clearTimeout: (handle) => clearTimeout(handle),
			log: (message, context) => logVoice(message, context),
		});
	}
	const microphoneController = microphoneControllerRef.current;

	const applyMicGainVolume = useCallback(
		(volume: number) => {
			microphoneController.setGainVolume(volume);
		},
		[microphoneController],
	);

	useEffect(() => {
		// These render values trigger re-evaluation; the controller reads their
		// latest ref/store values through its injected activity-mode adapter.
		void isConnected;
		void ownVoiceState.micMuted;
		microphoneController.syncActivity();
	}, [isConnected, microphoneController, ownVoiceState.micMuted]);

	useEffect(() => {
		const handleVolumeSettingsUpdated = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const detail: TVolumeSettingsUpdatedDetail = event.detail;

			if (detail.key !== OWN_MIC_VOLUME_KEY) {
				return;
			}

			const nextVolume = clampVolumePercent(detail.volume);
			const hasMicGainPipeline = microphoneController.hasGainPipeline();
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
	}, [applyMicGainVolume, currentVoiceChannelId, localAudioStream, microphoneController]);

	const publishWebcamTrack = useCallback(
		async (
			stream: MediaStream,
			track: MediaStreamTrack,
			options: {
				stopTracksOnFailure?: boolean;
				isCurrent?: () => boolean;
			} = {},
		) => {
			const transport = producerTransport.current;
			if (!transport || transport.closed || (options.isCurrent && !options.isCurrent())) {
				throw new VoiceSessionExecutionSupersededError();
			}
			setLocalVideoStream(stream);
			const stopTracksOnFailure = options.stopTracksOnFailure ?? true;
			let videoProducer: Producer<AppData> | undefined;

			try {
				logVoice('Obtained video track', { videoTrack: track });

				track.contentHint = 'motion';

				const preferredVideoCodec = resolvePreferredVideoCodec(sendRtpCapabilities.current, devices.videoCodec);

				if (devices.videoCodec !== VideoCodecPreference.AUTO && !preferredVideoCodec) {
					logVoice('Preferred webcam codec unavailable, falling back to auto', {
						preferredCodec: devices.videoCodec,
					});
				}

				const requestedWebcamResolution = getResWidthHeight(devices?.webcamResolution);
				const webcamTrackSettings = track.getSettings();
				const webcamWidth = webcamTrackSettings.width ?? requestedWebcamResolution.width;
				const webcamHeight = webcamTrackSettings.height ?? requestedWebcamResolution.height;
				const webcamFramerate = webcamTrackSettings.frameRate ?? devices.webcamFramerate;
				const webcamBitratePolicy = getVideoBitratePolicy({
					profile: 'camera',
					width: webcamWidth,
					height: webcamHeight,
					frameRate: webcamFramerate,
					codec: getBitrateCodecFromMimeType(preferredVideoCodec),
				});

				logVoice('Webcam bitrate policy resolved', {
					width: webcamWidth,
					height: webcamHeight,
					frameRate: webcamFramerate,
					codec: preferredVideoCodec?.mimeType,
					startKbps: webcamBitratePolicy.startKbps,
					maxKbps: webcamBitratePolicy.maxKbps,
				});

				const webcamEncodings = createVideoProducerEncodings().map((encoding) => ({
					...encoding,
					maxBitrate: webcamBitratePolicy.maxKbps * 1000,
				}));
				videoProducer = await transport.produce({
					track,
					encodings: webcamEncodings,
					codec: preferredVideoCodec,
					codecOptions: {
						videoGoogleStartBitrate: webcamBitratePolicy.startKbps,
						videoGoogleMaxBitrate: webcamBitratePolicy.maxKbps,
					},
					stopTracks: false,
					appData: { kind: StreamKind.VIDEO },
				});

				if (!videoProducer) {
					throw new Error('Failed to create webcam producer');
				}

				const createdVideoProducer = videoProducer;
				await applyVideoDegradationPreference(createdVideoProducer.rtpSender, 'webcam');
				if (
					producerTransport.current !== transport ||
					transport.closed ||
					(options.isCurrent && !options.isCurrent())
				) {
					throw new VoiceSessionExecutionSupersededError();
				}

				localVideoProducer.current = createdVideoProducer;

				logVoice('Webcam video producer created', {
					producer: createdVideoProducer,
				});

				bindProducerCloseHandler({
					producer: createdVideoProducer,
					kind: StreamKind.VIDEO,
					producerRef: localVideoProducer,
					logLabel: 'Video',
				});

				track.onended = () => {
					logVoice('Video track ended, cleaning up webcam');

					stream.getVideoTracks().forEach((currentTrack) => {
						currentTrack.stop();
					});
					createdVideoProducer.close();

					setLocalVideoStream((currentStream) => {
						return currentStream === stream ? undefined : currentStream;
					});

					updateOwnVoiceState({ webcamEnabled: false });

					void (async () => {
						try {
							await sendOwnVoiceStateUpdate({
								webcamEnabled: false,
							});
						} catch (error) {
							logVoice('Error syncing webcam state after native track end', { error });
						}
					})();
				};
			} catch (error) {
				videoProducer?.close();
				if (localVideoProducer.current === videoProducer) {
					localVideoProducer.current = undefined;
				}
				if (stopTracksOnFailure) {
					stream.getTracks().forEach((currentTrack) => {
						currentTrack.stop();
					});
					setLocalVideoStream((currentStream) => {
						return currentStream === stream ? undefined : currentStream;
					});
				}
				throw error;
			}
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
				const screenWidth = screenTrackSettings.width ?? requestedScreenResolution.width;
				const screenHeight = screenTrackSettings.height ?? requestedScreenResolution.height;
				const screenFramerate = screenTrackSettings.frameRate ?? devices.screenFramerate;
				// The bitrate policy's max ceiling is per-codec, so resolve the codec
				// first using a codec-agnostic base policy, then recompute the policy
				// with the resolved codec.
				const baseScreenBitratePolicy = getVideoBitratePolicy({
					profile: 'screen',
					width: screenWidth,
					height: screenHeight,
					frameRate: screenFramerate,
				});

				const preferredVideoCodec = resolveScreenShareVideoCodec(sendRtpCapabilities.current, devices.videoCodec, {
					width: screenWidth,
					height: screenHeight,
					framerate: screenFramerate,
					bitrate: baseScreenBitratePolicy.startKbps * 1000,
				});
				if (devices.videoCodec !== VideoCodecPreference.AUTO && !preferredVideoCodec) {
					logVoice('Preferred screen share codec unavailable, falling back to auto', {
						preferredCodec: devices.videoCodec,
					});
				}

				const screenBitratePolicy = getVideoBitratePolicy({
					profile: 'screen',
					width: screenWidth,
					height: screenHeight,
					frameRate: screenFramerate,
					codec: getBitrateCodecFromMimeType(preferredVideoCodec),
				});

				logVoice('Screen share bitrate policy resolved', {
					width: screenWidth,
					height: screenHeight,
					frameRate: screenFramerate,
					codec: preferredVideoCodec?.mimeType,
					startKbps: screenBitratePolicy.startKbps,
					maxKbps: screenBitratePolicy.maxKbps,
				});

				// Add a max-bitrate ceiling (bps) so congestion control has headroom to
				// ramp during high-motion content before it resorts to downscaling. Spread
				// onto the existing encoding so scalabilityMode/temporal SVC is preserved.
				const screenShareEncodings = createVideoProducerEncodings().map((encoding) => ({
					...encoding,
					maxBitrate: screenBitratePolicy.maxKbps * 1000,
				}));

				screenShareProducer = await transport.produce({
					track,
					encodings: screenShareEncodings,
					codecOptions: {
						videoGoogleStartBitrate: screenBitratePolicy.startKbps,
						videoGoogleMaxBitrate: screenBitratePolicy.maxKbps,
					},
					codec: preferredVideoCodec,
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

					stream.getTracks().forEach((currentTrack) => {
						currentTrack.stop();
					});
					createdScreenShareProducer.close();
					localScreenShareAudioProducer.current?.close();
					localScreenShareAudioProducer.current = undefined;
					appAudioPublishIntentRef.current = undefined;
					standbyDisplayAudioTrackRef.current = undefined;
					standbyDisplayAudioStreamRef.current = undefined;
					trackDesktopAppAudioCleanupRef.current();

					setLocalScreenShare(undefined);
					setLocalScreenShareAudio(undefined);
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
				isCurrent?: () => boolean;
			} = {},
		) => {
			const transport = producerTransport.current;
			if (!transport || transport.closed || (options.isCurrent && !options.isCurrent())) {
				throw new VoiceSessionExecutionSupersededError();
			}
			setLocalScreenShareAudio(stream);

			const screenAudioProducer = await transport.produce({
				track,
				stopTracks: false,
				codecOptions: {
					opusStereo: true,
					opusFec: true,
					opusDtx: false,
					opusMaxAverageBitrate: SCREEN_SHARE_AUDIO_TARGET_BITRATE_BPS,
				},
				appData: { kind: StreamKind.SCREEN_AUDIO },
			});

			if (producerTransport.current !== transport || transport.closed || (options.isCurrent && !options.isCurrent())) {
				screenAudioProducer.close();
				throw new VoiceSessionExecutionSupersededError();
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

	useScreenShareQualityGuard({
		screenShareProducerRef: localScreenShareProducer,
		active: localScreenShareStream !== undefined,
	});

	const cleanupMicAudioPipeline = useCallback(() => microphoneController.cleanup(), [microphoneController]);

	// Acquire mic stream and build the processing pipeline (WASM denoise + gain).
	// This has no dependency on the mediasoup device or transports, so it can run
	// concurrently with device.load() and transport creation during voice join.
	const prepareMicPipeline = useCallback(async (): Promise<TMicrophonePreparedPipeline> => {
		const micProcessingConfig = resolveMicProcessingConfig(devices);
		const micConstraints: MediaTrackConstraints = {
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

		return microphoneController.prepare({
			constraints: micConstraints,
			processingEnabled: micProcessingConfig.wasmNoiseSuppressionEnabled,
			gainVolume: getStoredVolume(OWN_MIC_VOLUME_KEY),
			selectedMicrophoneId: devices.microphoneId,
		});
	}, [devices, microphoneController]);

	// Attach the prepared mic pipeline to the producer transport. Must be called
	// after the producer transport is ready.
	const produceMicTrack = useCallback(
		async (prepared: TMicrophonePreparedPipeline, isCurrent?: () => boolean) => {
			await microphoneController.publish({ source: prepared, isCurrent });
		},
		[microphoneController],
	);

	const startMicStream = useCallback(async () => {
		// Serialize mic pipeline operations so concurrent callers (device change,
		// unmute, volume threshold) queue rather than race each other.
		const previousMutex = micPipelineMutexRef.current;
		let resolve: () => void = () => {};
		micPipelineMutexRef.current = new Promise<void>((r) => {
			resolve = r;
		});

		let prepared: TMicrophonePreparedPipeline | undefined;

		try {
			await previousMutex;
			logVoice('Starting microphone stream');
			prepared = await prepareMicPipeline();
			await produceMicTrack(prepared);
		} catch (error) {
			logVoice('Error starting microphone stream', { error });

			// A failed prepare cleans up after itself (prepared stays undefined);
			// after a successful prepare, tear down only while this build still
			// owns the shared refs so a superseded start cannot destroy the
			// pipeline a newer build installed.
			if (prepared && microphoneController.owns(prepared)) {
				await cleanupMicAudioPipeline();
			}
		} finally {
			resolve();
		}
	}, [prepareMicPipeline, produceMicTrack, cleanupMicAudioPipeline, microphoneController]);
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

	// A "Default" mic selection follows the *system* default input, but the
	// microphoneId-diff restart above can't see that move (its id stays
	// undefined). When a driver like NVIDIA Broadcast starts, it makes itself the
	// default mic and fires a `devicechange`, yet our open capture stays pinned to
	// the previous device — so peers keep hearing the unfiltered input until a
	// manual rejoin. Re-acquire when the resolved system default no longer matches
	// the device we're actually capturing. Only relevant for a Default selection;
	// a specific device is handled by didMicCaptureSettingsChange.
	useEffect(() => {
		if (currentVoiceChannelId === undefined || devices.microphoneId !== undefined) {
			return;
		}

		const mediaDevices = navigator.mediaDevices;

		if (!mediaDevices?.addEventListener) {
			return;
		}

		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let defaultInputCheckGeneration = 0;

		const clearRetryTimer = () => {
			if (retryTimer !== undefined) {
				clearTimeout(retryTimer);
				retryTimer = undefined;
			}
		};

		const cancelDefaultInputChecks = () => {
			defaultInputCheckGeneration += 1;
			clearRetryTimer();
		};

		const checkSystemDefaultInput = async (): Promise<'reacquired' | 'pending' | 'stop'> => {
			const rawTrack = microphoneController.getRawTrack();

			if (rawTrack?.readyState !== 'live') {
				return 'stop';
			}

			let inputs: { deviceId: string; groupId: string }[];

			try {
				inputs = (await mediaDevices.enumerateDevices())
					.filter((device) => device.kind === 'audioinput')
					.map((device) => ({ deviceId: device.deviceId, groupId: device.groupId }));
			} catch (error) {
				logVoice('Failed to inspect default input after device change', { error });
				return 'pending';
			}

			const capturedGroupId = rawTrack.getSettings().groupId;
			const defaultGroupId = resolveDefaultInputGroupId(inputs);

			if (!didDefaultInputDeviceChange({ capturedGroupId, defaultGroupId })) {
				return 'pending';
			}

			logVoice('System default input moved under a Default selection, re-acquiring mic', {
				capturedGroupId,
				defaultGroupId,
			});

			// startMicStream re-runs cleanup + getUserMedia and is mutex-serialized.
			void startMicStreamRef.current?.();
			return 'reacquired';
		};

		const startDefaultInputMoveChecks = () => {
			const generation = (defaultInputCheckGeneration += 1);
			const retryUntilMs = Date.now() + DEFAULT_INPUT_DEVICE_CHANGE_RETRY_WINDOW_MS;

			const runCheck = async () => {
				retryTimer = undefined;

				const result = await checkSystemDefaultInput();

				if (generation !== defaultInputCheckGeneration) {
					return;
				}

				if (result !== 'pending' || Date.now() >= retryUntilMs) {
					return;
				}

				retryTimer = setTimeout(runCheck, DEFAULT_INPUT_DEVICE_CHANGE_RETRY_INTERVAL_MS);
			};

			void runCheck();
		};

		const handleDeviceChange = () => {
			if (debounceTimer !== undefined) {
				clearTimeout(debounceTimer);
			}
			cancelDefaultInputChecks();

			debounceTimer = setTimeout(() => {
				debounceTimer = undefined;
				startDefaultInputMoveChecks();
			}, DEFAULT_INPUT_DEVICE_CHANGE_DEBOUNCE_MS);
		};

		mediaDevices.addEventListener('devicechange', handleDeviceChange);

		return () => {
			if (debounceTimer !== undefined) {
				clearTimeout(debounceTimer);
			}
			cancelDefaultInputChecks();

			mediaDevices.removeEventListener('devicechange', handleDeviceChange);
		};
	}, [currentVoiceChannelId, devices.microphoneId, microphoneController]);

	const cleanupDesktopAppAudio = useCallback(
		async ({
			stopCapture = true,
			preserveCurrentAudio = false,
		}: {
			stopCapture?: boolean;
			preserveCurrentAudio?: boolean;
		} = {}) => {
			const desktopBridge = getDesktopBridge();
			// Detach everything this cleanup owns before its first await. A newer
			// capture can then install replacement resources without an older cleanup
			// reading or clearing them after it resumes.
			const startupTimeout = appAudioStartupTimeoutRef.current;
			appAudioStartupTimeoutRef.current = undefined;
			const removeFrameSubscription = removeAppAudioFrameSubscriptionRef.current;
			removeAppAudioFrameSubscriptionRef.current = undefined;
			const removeStatusSubscription = removeAppAudioStatusSubscriptionRef.current;
			removeAppAudioStatusSubscriptionRef.current = undefined;
			const nativeIngestWasActive = nativeAppAudioIngestActiveRef.current;
			nativeAppAudioIngestActiveRef.current = false;
			const activeSession = appAudioSessionRef.current;
			appAudioSessionRef.current = undefined;
			const appAudioPipeline = appAudioPipelineRef.current;
			appAudioPipelineRef.current = undefined;
			const ownedAudioStream = localScreenShareAudioStreamRef.current;

			if (startupTimeout !== undefined) {
				window.clearTimeout(startupTimeout);
			}

			removeFrameSubscription?.();
			removeStatusSubscription?.();

			// Native RTP ingest teardown: stop the main-process Opus/SRTP sender and
			// ask the server to close the SCREEN_AUDIO producer (which also releases
			// its PlainTransport). The worklet pipeline below is never built on this
			// path, so it is a no-op for native ingest.
			if (nativeIngestWasActive) {
				try {
					await desktopBridge?.stopAppAudioRtp?.();
				} catch (error) {
					logVoice('Failed to stop native app audio RTP sender', { error });
				}

				try {
					await getTRPCClient().voice.closeProducer.mutate({ kind: StreamKind.SCREEN_AUDIO });
				} catch (error) {
					logVoice('Failed to close native app audio producer on server', { error });
				}
			}

			if (stopCapture && desktopBridge && activeSession?.sessionId) {
				try {
					await desktopBridge.stopAppAudioCapture(activeSession.sessionId);
				} catch (error) {
					logVoice('Failed to stop desktop app audio capture', { error });
				}
			}

			if (appAudioPipeline) {
				await appAudioPipeline.destroy().catch((error) => {
					logVoice('Failed to clean up desktop app audio pipeline', { error });
				});
			}

			if (!preserveCurrentAudio) {
				setLocalScreenShareAudio((currentStream) => {
					return currentStream === ownedAudioStream ? undefined : currentStream;
				});
			}
		},
		[setLocalScreenShareAudio],
	);
	const desktopAppAudioCleanupPromiseRef = useRef<Promise<void> | undefined>(undefined);

	const trackDesktopAppAudioCleanup = useCallback(
		(options?: { stopCapture?: boolean; preserveCurrentAudio?: boolean }) => {
			const previousCleanup = desktopAppAudioCleanupPromiseRef.current;
			const cleanupPromise = (previousCleanup ?? Promise.resolve())
				.catch(() => undefined)
				.then(() => cleanupDesktopAppAudio(options))
				.finally(() => {
					if (desktopAppAudioCleanupPromiseRef.current === cleanupPromise) {
						desktopAppAudioCleanupPromiseRef.current = undefined;
					}
				});
			desktopAppAudioCleanupPromiseRef.current = cleanupPromise;
		},
		[cleanupDesktopAppAudio],
	);
	const trackDesktopAppAudioCleanupRef = useRef(trackDesktopAppAudioCleanup);
	trackDesktopAppAudioCleanupRef.current = trackDesktopAppAudioCleanup;

	// Attempts native RTP ingest for shared app/system audio: capture PCM in the
	// sidecar (without the renderer worklet channel), allocate a server
	// PlainTransport, start the desktop main Opus/SRTP sender, and publish once the
	// server observes first media. Returns true when the SCREEN_AUDIO producer is
	// live server-side; returns false (after cleaning up its own attempt) so the
	// caller falls back to the worklet path. Hard auth failures reject and are
	// surfaced by the caller rather than silently falling back.
	const startNativeAppAudioIngest = useCallback(
		async ({
			desktopBridge,
			captureInput,
			audioMode,
		}: {
			desktopBridge: TDesktopBridge;
			captureInput: TStartAppAudioCaptureInput;
			audioMode: ScreenAudioMode.APP | ScreenAudioMode.SYSTEM;
		}): Promise<'published' | 'abandoned' | 'fallback'> => {
			const startAppAudioRtp = desktopBridge.startAppAudioRtp;
			const stopAppAudioRtp = desktopBridge.stopAppAudioRtp;

			// Capability gate: only newer desktop builds expose the native RTP bridge.
			if (typeof startAppAudioRtp !== 'function' || typeof stopAppAudioRtp !== 'function') {
				logVoice('Native app audio ingest unavailable (bridge missing); using worklet path');
				return 'fallback';
			}

			// Rollout gate: opt-in until validated end-to-end and in a packaged build.
			if (!isNativeAppAudioIngestEnabled(devices.nativeAppAudioIngestEnabled)) {
				logVoice('Native app audio ingest disabled; using worklet path');
				return 'fallback';
			}

			// Claim this attempt's generation. Shared/global state is only ours to
			// tear down while we remain the current attempt.
			const attemptGeneration = ++nativeAppAudioIngestGenerationRef.current;
			const ownsCurrentAttempt = () => nativeAppAudioIngestGenerationRef.current === attemptGeneration;
			const hasPublishIntent = () => appAudioPublishIntentRef.current !== undefined;
			const ownsPublishIntent = () => ownsCurrentAttempt() && hasPublishIntent();
			const nativeAudioLabel = audioMode === ScreenAudioMode.SYSTEM ? 'System audio' : 'Per-app audio';

			let captureStarted = false;
			// Captured from this attempt's own session/ingest rather than read from
			// shared refs at teardown time, so we never stop a newer attempt's
			// capture or abort a newer attempt's server ingest.
			let attemptSessionId: string | undefined;
			let attemptTransportId: string | undefined;

			const teardownNativeAttempt = async () => {
				const ownsGlobalState = ownsCurrentAttempt();

				// The singleton RTP sender and the session/active refs belong to the
				// newest attempt; only touch them if no newer attempt has superseded us.
				if (ownsGlobalState) {
					try {
						await stopAppAudioRtp();
					} catch (error) {
						logVoice('Failed to stop native app audio RTP sender during teardown', { error });
					}
				}

				if (captureStarted && attemptSessionId) {
					try {
						await desktopBridge.stopAppAudioCapture(attemptSessionId);
					} catch (error) {
						logVoice('Failed to stop native app audio capture during teardown', { error });
					}
				}

				// Release the server-side PlainTransport for an ingest that was created
				// but never published; scoped by transport id so it is a no-op once a
				// newer attempt has replaced the ingest. Without this the UDP port leaks
				// until leave or the next native attempt.
				if (attemptTransportId) {
					try {
						await getTRPCClient().voice.abortAppAudioIngest.mutate({ transportId: attemptTransportId });
					} catch (error) {
						logVoice('Failed to abort native app audio ingest during teardown', { error });
					}
				}

				if (ownsGlobalState) {
					removeAppAudioStatusSubscriptionRef.current?.();
					removeAppAudioStatusSubscriptionRef.current = undefined;
					appAudioSessionRef.current = undefined;
					nativeAppAudioIngestActiveRef.current = false;
				}
			};

			let fallbackReason: 'no-first-media' | 'error' = 'error';

			try {
				// Capture without the renderer worklet frame channel: the desktop main
				// process consumes the PCM egress and feeds the RTP sender directly.
				const session = await desktopBridge.startAppAudioCapture(captureInput, { openFrameChannel: false });
				attemptSessionId = session.sessionId;
				captureStarted = true;
				if (!ownsPublishIntent()) {
					logVoice('Native app audio ingest abandoned after capture; tearing down', {
						sessionId: session.sessionId,
						superseded: !ownsCurrentAttempt(),
					});
					await teardownNativeAttempt();
					return 'abandoned';
				}

				appAudioSessionRef.current = session;
				removeAppAudioStatusSubscriptionRef.current?.();
				removeAppAudioStatusSubscriptionRef.current = desktopBridge.subscribeAppAudioStatus(
					(statusEvent: TAppAudioStatusEvent) => {
						logVoice('Received native app audio status event', {
							sessionId: statusEvent.sessionId,
							targetId: statusEvent.targetId,
							reason: statusEvent.reason,
							error: statusEvent.error,
						});
						if (
							statusEvent.sessionId !== session.sessionId ||
							statusEvent.sessionId !== appAudioSessionRef.current?.sessionId ||
							!nativeAppAudioIngestActiveRef.current
						) {
							return;
						}

						void (async () => {
							toast.warning(
								statusEvent.error
									? `${nativeAudioLabel} capture ended (${statusEvent.reason}): ${statusEvent.error}`
									: `${nativeAudioLabel} capture ended (${statusEvent.reason}). Screen video will continue without shared audio.`,
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

				const ingest = await getTRPCClient().voice.createAppAudioIngest.mutate();
				attemptTransportId = ingest.id;
				if (!ownsPublishIntent()) {
					logVoice('Native app audio ingest abandoned after ingest allocation; tearing down', {
						transportId: ingest.id,
						superseded: !ownsCurrentAttempt(),
					});
					await teardownNativeAttempt();
					return 'abandoned';
				}

				const { srtpKeyBase64 } = await startAppAudioRtp({
					ip: ingest.ip,
					port: ingest.port,
					ssrc: ingest.ssrc,
					payloadType: ingest.rtpParameters.codecs?.[0]?.payloadType,
				});
				if (!ownsPublishIntent()) {
					logVoice('Native app audio ingest abandoned after RTP sender start; tearing down', {
						transportId: ingest.id,
						superseded: !ownsCurrentAttempt(),
					});
					await teardownNativeAttempt();
					return 'abandoned';
				}

				const result = await getTRPCClient().voice.produceAppAudio.mutate({
					transportId: ingest.id,
					srtpParameters: {
						cryptoSuite: ingest.srtpParameters.cryptoSuite,
						keyBase64: srtpKeyBase64,
					},
				});

				if ('producerId' in result) {
					// The attempt can be abandoned while produceAppAudio is in flight: the
					// user stops the share (clearing appAudioPublishIntentRef) or a newer
					// attempt supersedes this generation. cleanupDesktopAppAudio gates its
					// native teardown on nativeAppAudioIngestActiveRef, which is still false
					// until the line below, so committing here would strand a live
					// SCREEN_AUDIO producer plus a running RTP sender/UDP socket that the
					// stop-path cleanup already skipped. Tear our own attempt down instead.
					if (!ownsPublishIntent()) {
						logVoice('Native app audio ingest abandoned after produce; tearing down', {
							producerId: result.producerId,
							superseded: !ownsCurrentAttempt(),
						});
						await teardownNativeAttempt();
						return 'abandoned';
					}

					nativeAppAudioIngestActiveRef.current = true;
					logVoice('Native app audio ingest active', { producerId: result.producerId });
					return 'published';
				}

				// Operational fallback: server observed no first media within the gate.
				fallbackReason = 'no-first-media';
			} catch (error) {
				// Authorization denial is hard and must NEVER fall back to the worklet
				// path — that path also produces SCREEN_AUDIO and would escape the
				// SHARE_SCREEN gate. Tear down the attempt and rethrow.
				if (isAuthDenialError(error)) {
					await teardownNativeAttempt();
					logVoice('Native app audio ingest denied (auth); not falling back', {
						code: getTrpcErrorData(error)?.code,
					});
					throw error;
				}

				logVoice('Native app audio ingest attempt errored; falling back to worklet', {
					error,
					code: getTrpcErrorData(error)?.code,
				});
			}

			// Operational fallback: clean up the native attempt and let the caller use
			// the worklet path. The single binary egress is left with no native sink.
			await teardownNativeAttempt();
			logVoice('Native app audio ingest falling back to worklet path', { reason: fallbackReason });

			return 'fallback';
		},
		[
			cleanupDesktopAppAudio,
			devices.nativeAppAudioIngestEnabled,
			localScreenShareAudioProducer,
			setLocalScreenShareAudio,
		],
	);

	const startDesktopAppAudioWorklet = useCallback(
		async ({
			desktopBridge,
			captureInput,
			audioMode,
			displayStream,
			displayAudioTrack,
			showWarnings = true,
		}: {
			desktopBridge: TDesktopBridge;
			captureInput: TStartAppAudioCaptureInput;
			audioMode: ScreenAudioMode.APP | ScreenAudioMode.SYSTEM;
			displayStream?: MediaStream;
			displayAudioTrack?: MediaStreamTrack;
			showWarnings?: boolean;
		}): Promise<TDesktopAppAudioWorkletStartResult> => {
			const sidecarAudioLabel = audioMode === ScreenAudioMode.SYSTEM ? 'System audio' : 'Per-app audio';

			try {
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
				appAudioSessionRef.current = appAudioSession;

				const appAudioPipeline = await createDesktopAppAudioPipeline(appAudioSession, {
					mode: 'stable',
					logLabel: audioMode === ScreenAudioMode.SYSTEM ? 'system-audio' : 'per-app-audio',
					insertSilenceOnDroppedFrames: true,
				});
				let hasReceivedSessionFrame = false;

				appAudioPipelineRef.current = appAudioPipeline;

				const startupTimeout = window.setTimeout(() => {
					if (hasReceivedSessionFrame || appAudioSessionRef.current?.sessionId !== appAudioSession.sessionId) {
						return;
					}

					logVoice('Sidecar produced no audio frames after startup', {
						sessionId: appAudioSession.sessionId,
						targetId: appAudioSession.targetId,
					});
					if (showWarnings) {
						toast.warning(
							`${sidecarAudioLabel} started but produced no audio frames. Screen video will continue without shared audio.`,
						);
					}
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
							if (showWarnings) {
								toast.warning(
									statusEvent.error
										? `${sidecarAudioLabel} capture ended (${statusEvent.reason}): ${statusEvent.error}`
										: `${sidecarAudioLabel} capture ended (${statusEvent.reason}). Screen video will continue without shared audio.`,
								);
							}
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

				if (displayAudioTrack) {
					displayAudioTrack.stop();
					displayStream?.removeTrack(displayAudioTrack);
				}

				const appAudioTrack = appAudioPipeline.track;
				await publishScreenShareAudioTrack(appAudioPipeline.stream, appAudioTrack, {
					onTrackEnded: () => {
						return cleanupDesktopAppAudio({
							stopCapture: false,
						});
					},
				});

				return { kind: 'published', displayAudioTrack: undefined };
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

				if (audioMode === ScreenAudioMode.SYSTEM && displayAudioTrack?.readyState === 'live') {
					logVoice('Falling back to display-media loopback for system audio');
					if (showWarnings) {
						toast.warning(
							issueToastMessage
								? `${issueToastMessage} Falling back to standard system audio (without echo exclusion).`
								: 'Sidecar audio capture failed. Falling back to standard system audio (without echo exclusion).',
						);
					}

					return { kind: 'display-fallback', displayAudioTrack };
				}

				if (showWarnings) {
					toast.warning(
						issueToastMessage
							? `${issueToastMessage} Continuing without shared audio.`
							: `${sidecarAudioLabel} capture failed. Continuing without shared audio.`,
					);
				}

				if (displayAudioTrack) {
					displayAudioTrack.stop();
					displayStream?.removeTrack(displayAudioTrack);
				}

				return { kind: 'none', displayAudioTrack: undefined };
			}
		},
		[cleanupDesktopAppAudio, localScreenShareAudioProducer, publishScreenShareAudioTrack, setLocalScreenShareAudio],
	);

	const desktopAppAudioRecoveryPromiseRef = useRef<Promise<void> | undefined>(undefined);

	const runDesktopAppAudioRecovery = useCallback(async (): Promise<void> => {
		const intent = appAudioPublishIntentRef.current;

		if (!intent) {
			return;
		}

		const desktopBridge = getDesktopBridge();
		if (!desktopBridge) {
			logVoice('Skipping desktop app audio recovery because desktop bridge is unavailable');
			return;
		}

		const currentScreenShareStream = localScreenShareStreamRef.current;
		const currentScreenShareTrack = currentScreenShareStream?.getVideoTracks()[0];
		if (!currentScreenShareStream || !currentScreenShareTrack || currentScreenShareTrack.readyState !== 'live') {
			logVoice('Skipping desktop app audio recovery because screen share is no longer live');
			appAudioPublishIntentRef.current = undefined;
			return;
		}

		const currentScreenShareAudioStream = localScreenShareAudioStreamRef.current;
		const currentScreenShareAudioTrack = currentScreenShareAudioStream?.getAudioTracks()[0];
		const currentPipelineTrack = appAudioPipelineRef.current?.track;
		const displayFallbackTrack =
			currentScreenShareAudioTrack &&
			currentScreenShareAudioTrack.readyState === 'live' &&
			currentScreenShareAudioTrack !== currentPipelineTrack
				? currentScreenShareAudioTrack
				: undefined;

		logVoice('Recovering desktop app audio from publish intent', {
			sourceId: intent.captureInput.sourceId,
			appAudioTargetId: intent.captureInput.appAudioTargetId,
			mode: intent.audioMode === ScreenAudioMode.SYSTEM ? 'system-exclude' : 'per-app',
			hasDisplayFallbackTrack: displayFallbackTrack !== undefined,
		});

		localScreenShareAudioProducer.current?.close();
		localScreenShareAudioProducer.current = undefined;

		await cleanupDesktopAppAudio({
			stopCapture: true,
			preserveCurrentAudio: false,
		});

		const captureInput = { ...intent.captureInput };
		const nativeIngestResult = await startNativeAppAudioIngest({
			desktopBridge,
			captureInput,
			audioMode: intent.audioMode,
		});

		if (nativeIngestResult === 'published' || nativeIngestResult === 'abandoned') {
			// 'published': native owns SCREEN_AUDIO. 'abandoned': the attempt tore
			// itself down because the intent was cleared/superseded mid-recovery.
			// Either way do not fall back to the worklet path.
			setLocalScreenShareAudio(undefined);
			return;
		}

		const workletResult = await startDesktopAppAudioWorklet({
			desktopBridge,
			captureInput,
			audioMode: intent.audioMode,
			displayStream: currentScreenShareAudioStream,
			displayAudioTrack: displayFallbackTrack,
			showWarnings: false,
		});

		if (workletResult.kind === 'display-fallback') {
			logVoice('Recovering desktop app audio with display-media loopback fallback');
			await publishScreenShareAudioTrack(
				new MediaStream([workletResult.displayAudioTrack]),
				workletResult.displayAudioTrack,
			);
			return;
		}

		if (workletResult.kind === 'none') {
			logVoice('Desktop app audio recovery completed without a recoverable audio path');
		}
	}, [
		cleanupDesktopAppAudio,
		localScreenShareAudioProducer,
		publishScreenShareAudioTrack,
		setLocalScreenShareAudio,
		startDesktopAppAudioWorklet,
		startNativeAppAudioIngest,
	]);

	// Serializes overlapping desktop app-audio recoveries. Voice session recovery
	// fires this fire-and-forget on every retry attempt, so a fast-failing retry can
	// launch a second recovery while the first is still publishing. Run concurrently,
	// the second's cleanupDesktopAppAudio() would stop the first's just-published RTP
	// sender and close its producer while the first still reports 'published' (so it
	// skips worklet fallback). Chaining on any in-flight recovery makes the latest
	// attempt re-establish on top of the previous one instead of interleaving.
	const recoverDesktopAppAudioFromIntent = useCallback((): Promise<void> => {
		const previousRecovery = desktopAppAudioRecoveryPromiseRef.current;

		const recovery = (async () => {
			if (previousRecovery) {
				await previousRecovery.catch(() => undefined);
			}

			await runDesktopAppAudioRecovery();
		})().finally(() => {
			if (desktopAppAudioRecoveryPromiseRef.current === recovery) {
				desktopAppAudioRecoveryPromiseRef.current = undefined;
			}
		});

		desktopAppAudioRecoveryPromiseRef.current = recovery;
		return recovery;
	}, [runDesktopAppAudioRecovery]);

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
		appAudioPublishIntentRef.current = undefined;
		standbyDisplayAudioTrackRef.current = undefined;
		standbyDisplayAudioStreamRef.current = undefined;
		screenShareTrackEndedHandlerRef.current = undefined;

		trackDesktopAppAudioCleanup();

		setLocalScreenShare(undefined);
		setLocalScreenShareAudio(undefined);
	}, [
		trackDesktopAppAudioCleanup,
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
					await desktopAppAudioCleanupPromiseRef.current;

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

							if (useSidecarAudio && desktopBridge && desktopSelection && sidecarAudioMode) {
								const captureInput: TStartAppAudioCaptureInput = {
									sourceId: desktopSelection.sourceId,
								};

								if (sidecarAudioMode === ScreenAudioMode.APP) {
									captureInput.appAudioTargetId = desktopSelection.appAudioTargetId;
								}

								appAudioPublishIntentRef.current = {
									audioMode: sidecarAudioMode,
									captureInput: { ...captureInput },
								};

								// Prefer native RTP ingest (desktop main encodes Opus + SRTP and
								// sends to a mediasoup PlainTransport). Falls back to the renderer
								// worklet path on older desktop/server builds, blocked UDP, or no
								// first media. Either way the producer surfaces as SCREEN_AUDIO.
								const nativeIngestResult = await startNativeAppAudioIngest({
									desktopBridge,
									captureInput,
									audioMode: sidecarAudioMode,
								});

								if (nativeIngestResult === 'published' || nativeIngestResult === 'abandoned') {
									// 'published': native ingest owns SCREEN_AUDIO. 'abandoned': the
									// attempt tore itself down because the share is going away (stop or
									// supersede mid-publish). Either way drop the display-captured audio
									// track so it is never published, and do not fall back to the worklet
									// path (which would republish SCREEN_AUDIO for an abandoned share).
									if (audioTrack) {
										audioTrack.stop();
										stream.removeTrack(audioTrack);
										audioTrack = undefined;
									}

									return videoTrack;
								}

								const workletResult = await startDesktopAppAudioWorklet({
									desktopBridge,
									captureInput,
									audioMode: sidecarAudioMode,
									displayStream: stream,
									displayAudioTrack: audioTrack,
								});

								audioTrack = workletResult.displayAudioTrack;

								if (workletResult.kind === 'published') {
									return videoTrack;
								}
							}

							if (audioTrack) {
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
						appAudioPublishIntentRef.current = undefined;
						standbyDisplayAudioTrackRef.current = undefined;
						standbyDisplayAudioStreamRef.current = undefined;
						await cleanupDesktopAppAudio();

						logVoice('Error starting screen share stream', { error });
						throw error;
					}
				},
			);
		},
		[
			cleanupDesktopAppAudio,
			devices.screenAudioMode,
			devices.screenFramerate,
			devices.screenResolution,
			publishScreenShareAudioTrack,
			publishScreenShareTrack,
			setLocalScreenShareAudio,
			startDesktopAppAudioWorklet,
			startNativeAppAudioIngest,
		],
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
			if (!opts?.preserveLocalMedia) {
				trackDesktopAppAudioCleanupRef.current();
			}
			void cleanupMicAudioPipeline();
			stopMonitoring();
			resetStats();
			voiceActivityStoreRef.current.clearAll();
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
			stopMonitoring,
			resetStats,
			cleanupMicAudioPipeline,
			clearLocalStreams,
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

			const videoStream = localVideoStreamRef.current;
			const videoTrack = videoStream?.getVideoTracks()[0];
			if (videoStream && videoTrack && videoTrack.readyState === 'live') {
				state.webcamEnabled = true;
				tasks.push(
					publishWebcamTrack(videoStream, videoTrack, {
						stopTracksOnFailure: false,
						isCurrent,
					}),
				);
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

			const screenShareAudioStream = localScreenShareAudioStreamRef.current;
			const screenShareAudioTrack = screenShareAudioStream?.getAudioTracks()[0];
			if (
				!appAudioPublishIntentRef.current &&
				screenShareAudioStream &&
				screenShareAudioTrack &&
				screenShareAudioTrack.readyState === 'live'
			) {
				const shouldCleanupDesktopAudio = appAudioPipelineRef.current?.track === screenShareAudioTrack;

				tasks.push(
					publishScreenShareAudioTrack(screenShareAudioStream, screenShareAudioTrack, {
						isCurrent,
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

			return { tasks, state };
		},
		[publishWebcamTrack, publishScreenShareTrack, publishScreenShareAudioTrack, cleanupDesktopAppAudio],
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
			const ownsSessionExecution = claimVoiceSessionExecution(sessionExecutionOwnershipRef.current);
			const isCurrent = (): boolean =>
				ownsSessionExecution() && (opts?.isCurrentRecovery === undefined || opts.isCurrentRecovery());

			return traceSentrySpan(
				{
					name: 'voice.init',
					op: 'voice.join',
					attributes: {
						'voice.channel_id': channelId,
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
					hasHandledTransportFailureRef.current = false;

					let micPrepPromise: Promise<TMicrophonePreparedPipeline | undefined> | undefined;
					const dispatchJoinLifecycle = opts?.preserveLocalMedia !== true && opts?.restoreWatchSnapshot === undefined;

					try {
						setLoading(true);
						if (dispatchJoinLifecycle) {
							dispatchVoiceSession({ type: 'JoinRequested', channelId });
						}

						throwIfRecoverySuperseded();
						routerRtpCapabilities.current = incomingRouterRtpCapabilities;

						const device = await Device.factory();

						// Start mic acquisition + WASM pipeline immediately — these have no
						// dependency on the mediasoup device or transports and are the slowest
						// part of startMicStream. Running them concurrently with device.load()
						// and transport creation saves ~200-300ms on join.
						micPrepPromise = prepareMicPipeline().catch((error) => {
							// prepareMicPipeline cleans up after its own failures, and a
							// superseded build must not touch the successor's pipeline —
							// so no shared teardown here.
							logVoice('Error preparing microphone pipeline', { error });
							return undefined;
						});

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
								await produceMicTrack(micPrepResult);
							} catch (error) {
								logVoice('Error attaching microphone to transport', { error });

								// Tear down only while this build's pipeline is still the
								// installed one — a detached attempt failing late must not
								// destroy the successor's mic.
								if (microphoneController.owns(micPrepResult)) {
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

							if (appAudioPublishIntentRef.current) {
								void recoverDesktopAppAudioFromIntent().catch((error) => {
									logVoice('Error recovering desktop app audio after reconnect restore', { error });
								});
							}
						}
						throwIfRecoverySuperseded();

						throwIfRecoverySuperseded();
						startMonitoring(producerTransport.current, consumerTransport.current);
						if (dispatchJoinLifecycle) {
							dispatchVoiceSession({ type: 'JoinSucceeded', channelId });
						}
						setLoading(false);

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
						if (preparedMic && microphoneController.owns(preparedMic)) {
							await cleanupMicAudioPipeline();
						}

						// UI/lifecycle state belongs to the current attempt; a superseded
						// recovery attempt must not stomp its successor's loading state.
						if (isCurrent()) {
							if (dispatchJoinLifecycle) {
								dispatchVoiceSession({ type: 'JoinFailed', reason: 'join-failed', channelId });
							}
							setLoading(false);
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
			microphoneController,
			createProducerTransport,
			createConsumerTransport,
			consumeExistingProducers,
			startMonitoring,
			producerTransport,
			consumerTransport,
			buildLocalMediaRepublishPlan,
			recoverDesktopAppAudioFromIntent,
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
					attributes: {
						'voice.channel_id': command.channelId,
					},
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
						if (recoveryJoinResult && canSpeakRef.current && startMicStreamRef.current) {
							republishTasks.push(
								startMicStreamRef.current().catch((error) => {
									logVoice('Error restarting microphone after voice session rejoin', { error });
								}),
							);
						} else if (currentAudioStream && currentAudioTrack && currentAudioTrack.readyState === 'live') {
							republishTasks.push(microphoneController.publish({ source: 'current', isCurrent: isCurrentAttempt }));
						} else if (currentAudioStream && canSpeakRef.current && startMicStreamRef.current) {
							republishTasks.push(
								startMicStreamRef.current().catch((error) => {
									logVoice('Error restarting microphone after voice transport recovery', { error });
								}),
							);
						}

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
			microphoneController,
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
		now: Date.now,
		random: Math.random,
		delay: delayVoiceSessionCommand,
		isOnline: isVoiceReconnectOnline,
		captureRecoverySnapshot: captureWatchedRemoteStreams,
		rebuildTransports,
		restoreVoiceSession,
		restoreWatchIntent: rehydrateWatchIntentOnly,
		recoverDesktopAppAudio: async () => {
			const recovery = recoverDesktopAppAudioFromIntent();
			// A completed rebuild must release the failure latch so a later,
			// independent transport failure can start a new recovery cycle.
			hasHandledTransportFailureRef.current = false;
			await recovery;
		},
		leaveVoiceSession: leaveAfterFailedTransportRecovery,
		clearFailedSession: clearFailedVoiceSession,
		reportCommandError: (command, error) => {
			reportError('Voice session command failed', error, {
				commandType: command.type,
				commandId: command.commandId,
				generation: command.generation,
			});
		},
		reportRebuildDetached: (command) => {
			logDebug('Voice transport rebuild detached a hung cancelled operation', {
				attempt: command.attempt + 1,
				channelId: command.channelId,
			});
		},
		reportRebuildTerminalFailure: (command, error) => {
			reportError('Voice transport recovery failed', error, {
				attempt: command.attempt + 1,
				channelId: command.channelId,
			});
		},
		reportRestoreDetached: (command) => {
			logDebug('Voice reconnect detached a hung cancelled operation', {
				attempt: command.attempt + 1,
				channelId: command.pending.channelId,
			});
		},
	});

	const setMicProcessingMuted = useCallback(
		(micMuted: boolean) => {
			microphoneController.setMuted(micMuted);
		},
		[microphoneController],
	);

	const { isStartingScreenShare, setMicMuted, toggleMic, toggleSound, toggleWebcam, toggleScreenShare } =
		useVoiceControls({
			startMicStream,
			localAudioStream,
			setMicProcessingMuted,
			startWebcamStream,
			stopWebcamStream,
			startScreenShareStream,
			stopScreenShareStream,
			requestScreenShareSelection: getDesktopBridge() ? requestDesktopScreenShareSelection : undefined,
		});

	const setMicMutedRef = useLatestRef(setMicMuted);
	const ownMicMutedRef = useLatestRef(ownVoiceState.micMuted);
	const ownSoundMutedRef = useLatestRef(ownVoiceState.soundMuted);
	const canSpeakRef = useLatestRef(channelCan(ChannelPermission.SPEAK));

	useEffect(() => {
		const pushTarget = resolveHeldPushMicTarget({
			isPushToTalkHeld: isPushToTalkHeldRef.current,
			isPushToMuteHeld: isPushToMuteHeldRef.current,
			micMutedBeforePush: micMutedBeforePushRef.current,
		});

		if (pushTarget === undefined || micMutedBeforePushRef.current === undefined || confirmedOwnMicMuted === undefined) {
			return;
		}

		if (confirmedOwnMicMuted !== pushTarget) {
			micMutedBeforePushRef.current = confirmedOwnMicMuted;
		}
	}, [confirmedOwnMicMuted]);

	const getPushMicState = useCallback(
		(): TPushMicState => ({
			isPushToTalkHeld: isPushToTalkHeldRef.current,
			isPushToMuteHeld: isPushToMuteHeldRef.current,
			micMutedBeforePush: micMutedBeforePushRef.current,
		}),
		[],
	);

	const setPushMicState = useCallback((state: TPushMicState) => {
		isPushToTalkHeldRef.current = state.isPushToTalkHeld;
		isPushToMuteHeldRef.current = state.isPushToMuteHeld;
		micMutedBeforePushRef.current = state.micMutedBeforePush;
	}, []);

	const clearPendingPushRelease = useCallback((kind?: TDesktopPushKeybindEvent['kind']) => {
		const timers = pushReleaseTimersRef.current;

		if ((kind === undefined || kind === 'talk') && timers.talk !== undefined) {
			clearTimeout(timers.talk);
			timers.talk = undefined;
		}

		if ((kind === undefined || kind === 'mute') && timers.mute !== undefined) {
			clearTimeout(timers.mute);
			timers.mute = undefined;
		}
	}, []);

	const applyPushMicOverride = useCallback(() => {
		const pushMicResolution = resolvePushMicState(getPushMicState(), ownSoundMutedRef.current);

		if (pushMicResolution.targetMicMuted !== undefined) {
			void setMicMutedRef.current(pushMicResolution.targetMicMuted, {
				playSound: false,
			});
		}

		if (pushMicResolution.shouldClearMicMutedBeforePush) {
			micMutedBeforePushRef.current = undefined;
		}
	}, [getPushMicState]);

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

		const applyPushKeybindEvent = (event: TDesktopPushKeybindEvent) => {
			setPushMicState(updatePushMicStateForKeyEvent(getPushMicState(), event, ownMicMutedRef.current));
			applyPushMicOverride();
		};

		const removeGlobalKeybindSubscription = desktopBridge.subscribeGlobalPushKeybindEvents((event) => {
			if (currentVoiceChannelIdRef.current === undefined || !canSpeakRef.current) {
				clearPendingPushRelease();
				setPushMicState(clearHeldPushMicState(getPushMicState()));
				applyPushMicOverride();
				return;
			}

			// A new event supersedes any pending release for THAT key only. An event
			// for the other key must not cancel it — otherwise that key's deferred
			// release would be dropped and its state left stuck held (e.g. a talk
			// press cancelling a pending mute release leaves the mic stuck muted).
			clearPendingPushRelease(event.kind);

			const releaseDelayMs = pushReleaseDelayMsRef.current;

			if (!event.active && releaseDelayMs > 0) {
				// Hold the push key's state briefly past key-up so a quick tap doesn't
				// clip the tail of speech (push-to-talk keeps the mic open;
				// push-to-mute keeps it muted). The other key's state is untouched.
				pushReleaseTimersRef.current[event.kind] = setTimeout(() => {
					pushReleaseTimersRef.current[event.kind] = undefined;
					applyPushKeybindEvent(event);
				}, releaseDelayMs);
				return;
			}

			applyPushKeybindEvent(event);
		});

		return () => {
			removeGlobalKeybindSubscription();
			clearPendingPushRelease();
			setPushMicState(clearHeldPushMicState(getPushMicState()));
			applyPushMicOverride();
			void desktopBridge.setGlobalPushKeybinds({}).catch((error) => {
				logVoice('Failed to clear global push keybinds', { error });
			});
		};
	}, [
		applyPushMicOverride,
		clearPendingPushRelease,
		devices.pushToMuteKeybind,
		devices.pushToTalkKeybind,
		getPushMicState,
		setPushMicState,
	]);

	useEffect(() => {
		if (currentVoiceChannelId === undefined || !channelCan(ChannelPermission.SPEAK)) {
			clearPendingPushRelease();
			setPushMicState(clearHeldPushMicState(getPushMicState()));
			applyPushMicOverride();
		}
	}, [
		applyPushMicOverride,
		channelCan,
		clearPendingPushRelease,
		currentVoiceChannelId,
		getPushMicState,
		setPushMicState,
	]);

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
			void microphoneController.dispose();
		};
	}, [microphoneController]);

	const contextValue = useMemo<TVoiceProvider>(
		() => ({
			loading,
			connectionStatus,
			audioVideoRefsMap: audioVideoRefsMap.current,
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
			loading,
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

export { TransportStatsContext, VoiceActivityContext, VoiceProvider, VoiceProviderContext };
