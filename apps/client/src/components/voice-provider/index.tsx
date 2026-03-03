import { requestScreenShareSelection as requestScreenShareSelectionDialog } from '@/features/dialogs/actions';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useChannelCan } from '@/features/server/hooks';
import {
  clearPendingVoiceReconnectChannelId,
  consumePendingVoiceReconnectChannelId
} from '@/features/server/reconnect-state';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { joinVoice } from '@/features/server/voice/actions';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import { logVoice } from '@/helpers/browser-logger';
import { getResWidthHeight } from '@/helpers/get-res-with-height';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import {
  ScreenAudioMode,
  type TAppAudioSession,
  type TAppAudioStatusEvent,
  type TDesktopScreenShareSelection
} from '@/runtime/types';
import {
  VideoCodecPreference,
  type TDeviceSettings
} from '@/types';
import {
  ChannelPermission,
  StreamKind,
  type TVoiceUserState
} from '@sharkord/shared';
import { Device } from 'mediasoup-client';
import type {
  RtpCapabilities,
  RtpCodecCapability
} from 'mediasoup-client/types';
import {
  createContext,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { toast } from 'sonner';
import { useDevices } from '../devices-provider/hooks/use-devices';
import {
  createDesktopAppAudioPipeline,
  type TDesktopAppAudioPipeline
} from './desktop-app-audio';
import { FloatingPinnedCard } from './floating-pinned-card';
import { useLocalStreams } from './hooks/use-local-streams';
import { usePendingStreams } from './hooks/use-pending-streams';
import { useRemoteStreams } from './hooks/use-remote-streams';
import {
  useTransportStats,
  type TransportStatsData
} from './hooks/use-transport-stats';
import { useTransports } from './hooks/use-transports';
import { useVoiceControls } from './hooks/use-voice-controls';
import { useVoiceEvents } from './hooks/use-voice-events';
import { getVideoBitratePolicy } from './video-bitrate-policy';
import type { TVolumeSettingsUpdatedDetail } from './volume-control-context';
import {
  getStoredVolume,
  OWN_MIC_VOLUME_KEY,
  VOLUME_SETTINGS_UPDATED_EVENT,
  VolumeControlProvider
} from './volume-control-context';

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
  FAILED = 'failed'
}

const VIDEO_CODEC_MIME_TYPE_BY_PREFERENCE: Record<string, string> = {
  [VideoCodecPreference.VP8]: 'video/VP8',
  [VideoCodecPreference.H264]: 'video/H264',
  [VideoCodecPreference.AV1]: 'video/AV1'
};
const AUDIO_OPUS_TARGET_BITRATE_BPS = 128_000;
const AUDIO_OPUS_PACKET_LOSS_PERC = 15;
const AUDIO_OPUS_CODEC_OPTIONS = {
  opusMaxAverageBitrate: AUDIO_OPUS_TARGET_BITRATE_BPS,
  opusDtx: true,
  opusFec: true,
  opusPacketLossPerc: AUDIO_OPUS_PACKET_LOSS_PERC
} as const;

type ResolvedMicProcessingConfig = {
  browserAutoGainControl: boolean;
  browserNoiseSuppression: boolean;
  browserEchoCancellation: boolean;
};

const resolvePreferredVideoCodec = (
  rtpCapabilities: RtpCapabilities | null,
  preference: VideoCodecPreference
): RtpCodecCapability | undefined => {
  if (!rtpCapabilities || preference === VideoCodecPreference.AUTO) {
    return undefined;
  }

  const preferredMimeType =
    VIDEO_CODEC_MIME_TYPE_BY_PREFERENCE[preference]?.toLowerCase();

  if (!preferredMimeType) {
    return undefined;
  }

  return (rtpCapabilities.codecs ?? []).find((codec) => {
    return codec.mimeType.toLowerCase() === preferredMimeType;
  });
};

const resolveMicProcessingConfig = (
  devices: TDeviceSettings
): ResolvedMicProcessingConfig => {
  return {
    browserAutoGainControl: devices.autoGainControl,
    browserNoiseSuppression: devices.noiseSuppression,
    browserEchoCancellation: devices.echoCancellation
  };
};

const didMicCaptureSettingsChange = (
  previousDevices: TDeviceSettings,
  nextDevices: TDeviceSettings
) => {
  return (
    previousDevices.microphoneId !== nextDevices.microphoneId ||
    previousDevices.micQualityMode !== nextDevices.micQualityMode ||
    previousDevices.echoCancellation !== nextDevices.echoCancellation ||
    previousDevices.noiseSuppression !== nextDevices.noiseSuppression ||
    previousDevices.autoGainControl !== nextDevices.autoGainControl
  );
};

const didWebcamCaptureSettingsChange = (
  previousDevices: TDeviceSettings,
  nextDevices: TDeviceSettings
) => {
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
  volume: number
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

  const sourceNode = audioContext.createMediaStreamSource(
    new MediaStream([inputTrack])
  );
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
    }
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
    channelId: number
  ) => Promise<void>;
} & Pick<
  ReturnType<typeof useLocalStreams>,
  | 'localAudioStream'
  | 'localVideoStream'
  | 'localScreenShareStream'
  | 'localScreenShareAudioStream'
> &
  Pick<
    ReturnType<typeof useRemoteStreams>,
    'remoteUserStreams' | 'externalStreams'
  > &
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
    averageBitrateSent: 0
  },
  audioVideoRefsMap: new Map(),
  getOrCreateRefs: () => ({
    videoRef: { current: null },
    audioRef: { current: null },
    screenShareRef: { current: null },
    screenShareAudioRef: { current: null },
    externalAudioRef: { current: null },
    externalVideoRef: { current: null }
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
    sharingScreen: false
  },
  localAudioStream: undefined,
  localVideoStream: undefined,
  localScreenShareStream: undefined,
  localScreenShareAudioStream: undefined,

  remoteUserStreams: {},
  externalStreams: {},
  pendingStreams: new Map()
});

type TVoiceProviderProps = {
  children: React.ReactNode;
};

const VoiceProvider = memo(({ children }: TVoiceProviderProps) => {
  const [loading, setLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    ConnectionStatus.DISCONNECTED
  );
  const routerRtpCapabilities = useRef<RtpCapabilities | null>(null);
  const sendRtpCapabilities = useRef<RtpCapabilities | null>(null);
  const audioVideoRefsMap = useRef<Map<number, AudioVideoRefs>>(new Map());
  const ownVoiceState = useOwnVoiceState();
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const channelCan = useChannelCan(currentVoiceChannelId);
  const { devices } = useDevices();
  const appAudioPipelineRef = useRef<TDesktopAppAudioPipeline | undefined>(
    undefined
  );
  const appAudioSessionRef = useRef<TAppAudioSession | undefined>(undefined);
  const removeAppAudioFrameSubscriptionRef = useRef<(() => void) | undefined>(
    undefined
  );
  const removeAppAudioStatusSubscriptionRef = useRef<(() => void) | undefined>(
    undefined
  );
  const appAudioStartupTimeoutRef = useRef<
    number | ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const rawMicStreamRef = useRef<MediaStream | undefined>(undefined);
  const micGainPipelineRef = useRef<TMicGainPipeline | undefined>(undefined);
  const standbyDisplayAudioTrackRef = useRef<MediaStreamTrack | undefined>(
    undefined
  );
  const standbyDisplayAudioStreamRef = useRef<MediaStream | undefined>(
    undefined
  );
  const isPushToTalkHeldRef = useRef(false);
  const isPushToMuteHeldRef = useRef(false);
  const micMutedBeforePushRef = useRef<boolean | undefined>(undefined);
  const reconnectingVoiceRef = useRef(false);
  const previousDevicesRef = useRef<TDeviceSettings | undefined>(undefined);

  const getOrCreateRefs = useCallback((remoteId: number): AudioVideoRefs => {
    if (!audioVideoRefsMap.current.has(remoteId)) {
      audioVideoRefsMap.current.set(remoteId, {
        videoRef: { current: null },
        audioRef: { current: null },
        screenShareRef: { current: null },
        screenShareAudioRef: { current: null },
        externalAudioRef: { current: null },
        externalVideoRef: { current: null }
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
    remoteUserStreams
  } = useRemoteStreams();
  const {
    pendingStreams,
    addPendingStream,
    removePendingStream,
    clearPendingStreamsForUser,
    clearAllPendingStreams
  } = usePendingStreams();

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
    clearLocalStreams
  } = useLocalStreams();

  const {
    producerTransport,
    consumerTransport,
    createProducerTransport,
    createConsumerTransport,
    consume,
    consumeExistingProducers,
    stopWatchingStream,
    cleanupTransports
  } = useTransports({
    addExternalStreamTrack,
    removeExternalStreamTrack,
    addRemoteUserStream,
    removeRemoteUserStream,
    addPendingStream,
    removePendingStream,
    clearAllPendingStreams
  });

  const acceptStream = useCallback(
    (remoteId: number, kind: StreamKind) => {
      const currentRouterRtpCapabilities = routerRtpCapabilities.current;

      if (!currentRouterRtpCapabilities) {
        logVoice('Cannot accept pending stream before voice is initialized', {
          remoteId,
          kind
        });
        return;
      }

      void consume(remoteId, kind, currentRouterRtpCapabilities);
    },
    [consume]
  );

  const {
    stats: transportStats,
    startMonitoring,
    stopMonitoring,
    resetStats
  } = useTransportStats();

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

    window.addEventListener(
      VOLUME_SETTINGS_UPDATED_EVENT,
      handleVolumeSettingsUpdated
    );

    return () => {
      window.removeEventListener(
        VOLUME_SETTINGS_UPDATED_EVENT,
        handleVolumeSettingsUpdated
      );
    };
  }, [applyMicGainVolume]);

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
          error
        });
      }
    }

    const rawMicStream = rawMicStreamRef.current;
    rawMicStreamRef.current = undefined;

    rawMicStream?.getTracks().forEach((track) => {
      track.stop();
    });
  }, [localAudioProducer]);

  const startMicStream = useCallback(async () => {
    try {
      logVoice('Starting microphone stream');

      await cleanupMicAudioPipeline();
      const micProcessingConfig = resolveMicProcessingConfig(devices);

      const micConstraints = {
        deviceId: {
          exact: devices.microphoneId
        },
        autoGainControl: micProcessingConfig.browserAutoGainControl,
        echoCancellation: micProcessingConfig.browserEchoCancellation,
        noiseSuppression: micProcessingConfig.browserNoiseSuppression,
        sampleRate: 48000
      };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints,
        video: false
      });

      logVoice('Microphone stream obtained', { stream });

      rawMicStreamRef.current = stream;

      const rawAudioTrack = stream.getAudioTracks()[0];

      if (rawAudioTrack) {
        let outboundStream = stream;
        let outboundAudioTrack = rawAudioTrack;

        const micGainPipeline = await createMicGainPipeline(
          outboundStream,
          getStoredVolume(OWN_MIC_VOLUME_KEY)
        );

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
          appData: { kind: StreamKind.AUDIO }
        });
        localAudioProducer.current = audioProducer;

        logVoice('Microphone audio producer created', {
          producer: audioProducer
        });

        audioProducer?.on('@close', async () => {
          logVoice('Audio producer closed');

          if (localAudioProducer.current === audioProducer) {
            localAudioProducer.current = undefined;
          }

          const trpc = getTRPCClient();

          try {
            await trpc.voice.closeProducer.mutate({
              kind: StreamKind.AUDIO
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
    producerTransport,
    setLocalAudioStream,
    localAudioProducer,
    devices,
    ownVoiceState.micMuted
  ]);

  const startWebcamStream = useCallback(async () => {
    try {
      logVoice('Starting webcam stream');

      const requestedWebcamResolution = getResWidthHeight(
        devices?.webcamResolution
      );

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: devices?.webcamId },
          frameRate: devices.webcamFramerate,
          ...requestedWebcamResolution
        }
      });

      logVoice('Webcam stream obtained', { stream });

      setLocalVideoStream(stream);

      const videoTrack = stream.getVideoTracks()[0];

      if (videoTrack) {
        logVoice('Obtained video track', { videoTrack });

        const preferredVideoCodec = resolvePreferredVideoCodec(
          sendRtpCapabilities.current,
          devices.videoCodec
        );

        if (
          devices.videoCodec !== VideoCodecPreference.AUTO &&
          !preferredVideoCodec
        ) {
          logVoice('Preferred webcam codec unavailable, falling back to auto', {
            preferredCodec: devices.videoCodec
          });
        }

        const webcamTrackSettings = videoTrack.getSettings();
        const webcamBitratePolicy = getVideoBitratePolicy({
          profile: 'camera',
          width: webcamTrackSettings.width ?? requestedWebcamResolution.width,
          height:
            webcamTrackSettings.height ?? requestedWebcamResolution.height,
          frameRate: webcamTrackSettings.frameRate ?? devices.webcamFramerate,
          codecMimeType: preferredVideoCodec?.mimeType
        });

        const videoProducer = await producerTransport.current?.produce({
          track: videoTrack,
          codec: preferredVideoCodec,
          codecOptions: {
            videoGoogleStartBitrate: webcamBitratePolicy.startKbps
          },
          appData: { kind: StreamKind.VIDEO }
        });
        localVideoProducer.current = videoProducer;

        logVoice('Webcam video producer created', {
          producer: videoProducer
        });

        videoProducer?.on('@close', async () => {
          logVoice('Video producer closed');

          if (localVideoProducer.current === videoProducer) {
            localVideoProducer.current = undefined;
          }

          const trpc = getTRPCClient();

          try {
            await trpc.voice.closeProducer.mutate({
              kind: StreamKind.VIDEO
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
    devices.videoCodec
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

    const shouldRestartMic = didMicCaptureSettingsChange(
      previousDevices,
      devices
    );
    const shouldRestartWebcam =
      ownVoiceState.webcamEnabled &&
      didWebcamCaptureSettingsChange(previousDevices, devices);

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
    stopWebcamStream
  ]);

  const cleanupDesktopAppAudio = useCallback(
    async ({
      stopCapture = true,
      preserveCurrentAudio = false
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
    [setLocalScreenShareAudio]
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
    localScreenShareAudioProducer
  ]);

  const requestDesktopScreenShareSelection =
    useCallback(async (): Promise<TDesktopScreenShareSelection | null> => {
      const desktopBridge = getDesktopBridge();

      if (!desktopBridge) {
        return null;
      }

      try {
        const [sources, capabilities] = await Promise.all([
          desktopBridge.listShareSources(),
          desktopBridge.getCapabilities()
        ]);

        if (sources.length === 0) {
          toast.error('No windows or screens were detected for sharing.');
          return null;
        }

        return requestScreenShareSelectionDialog({
          sources,
          capabilities,
          defaultAudioMode: devices.screenAudioMode
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
          const resolved =
            await desktopBridge.prepareScreenShare(desktopSelection);
          audioMode = resolved.effectiveMode;

          if (resolved.warning) {
            toast.warning(resolved.warning);
          }
        }

        if (
          desktopBridge &&
          desktopSelection &&
          audioMode === ScreenAudioMode.APP
        ) {
          try {
            logVoice('Starting per-app sidecar capture', {
              sourceId: desktopSelection.sourceId,
              appAudioTargetId: desktopSelection.appAudioTargetId
            });
            const appAudioSession = await desktopBridge.startAppAudioCapture({
              sourceId: desktopSelection.sourceId,
              appAudioTargetId: desktopSelection.appAudioTargetId
            });
            logVoice('Per-app sidecar capture started', {
              sessionId: appAudioSession.sessionId,
              targetId: appAudioSession.targetId
            });
            const appAudioPipeline = await createDesktopAppAudioPipeline(
              appAudioSession,
              {
                mode: 'stable',
                logLabel: 'per-app-audio',
                insertSilenceOnDroppedFrames: true,
                emitQueueTelemetry: true,
                queueTelemetryIntervalMs: 1_000
              }
            );
            let hasReceivedSessionFrame = false;

            appAudioSessionRef.current = appAudioSession;
            appAudioPipelineRef.current = appAudioPipeline;

            const startupTimeout = window.setTimeout(() => {
              if (
                hasReceivedSessionFrame ||
                appAudioSessionRef.current?.sessionId !==
                  appAudioSession.sessionId
              ) {
                return;
              }

              logVoice(
                'Per-app sidecar produced no audio frames after startup',
                {
                  sessionId: appAudioSession.sessionId,
                  targetId: appAudioSession.targetId
                }
              );
              toast.warning(
                'Per-app audio started but produced no audio frames. Screen video will continue without shared audio.'
              );
              localScreenShareAudioProducer.current?.close();
              localScreenShareAudioProducer.current = undefined;
              setLocalScreenShareAudio(undefined);
              void cleanupDesktopAppAudio({
                stopCapture: true,
                preserveCurrentAudio: false
              });
            }, 3000);
            appAudioStartupTimeoutRef.current = startupTimeout;

            removeAppAudioFrameSubscriptionRef.current?.();
            removeAppAudioFrameSubscriptionRef.current =
              desktopBridge.subscribeAppAudioFrames((frame) => {
                if (frame.sessionId === appAudioSession.sessionId) {
                  if (!hasReceivedSessionFrame) {
                    logVoice('Received first per-app audio frame', {
                      sessionId: frame.sessionId,
                      targetId: frame.targetId
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
            removeAppAudioStatusSubscriptionRef.current =
              desktopBridge.subscribeAppAudioStatus(
                (statusEvent: TAppAudioStatusEvent) => {
                  logVoice('Received per-app sidecar status event', {
                    sessionId: statusEvent.sessionId,
                    targetId: statusEvent.targetId,
                    reason: statusEvent.reason,
                    error: statusEvent.error
                  });
                  if (
                    statusEvent.sessionId !==
                    appAudioSessionRef.current?.sessionId
                  ) {
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
                        : `Per-app audio capture ended (${statusEvent.reason}). Screen video will continue without shared audio.`
                    );
                    localScreenShareAudioProducer.current?.close();
                    localScreenShareAudioProducer.current = undefined;
                    setLocalScreenShareAudio(undefined);

                    await cleanupDesktopAppAudio({
                      stopCapture: false,
                      preserveCurrentAudio: false
                    });
                  })();
                }
              );
          } catch (error) {
            logVoice('Failed to start per-app sidecar audio capture', {
              error
            });
            toast.warning(
              'Per-app audio capture failed. Continuing without shared audio.'
            );
            await cleanupDesktopAppAudio();
            audioMode = ScreenAudioMode.NONE;
          }
        }

        // Electron main only provides display-capture audio in system mode.
        // Requesting audio in per-app mode can abort capture startup.
        const shouldCaptureDisplayAudio = audioMode === ScreenAudioMode.SYSTEM;
        const requestedScreenResolution = getResWidthHeight(
          devices?.screenResolution
        );

        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            ...requestedScreenResolution,
            frameRate: devices?.screenFramerate
          },
          audio: shouldCaptureDisplayAudio
            ? {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
              }
            : false
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

          const preferredVideoCodec = resolvePreferredVideoCodec(
            sendRtpCapabilities.current,
            devices.videoCodec
          );

          if (
            devices.videoCodec !== VideoCodecPreference.AUTO &&
            !preferredVideoCodec
          ) {
            logVoice(
              'Preferred screen share codec unavailable, falling back to auto',
              {
                preferredCodec: devices.videoCodec
              }
            );
          }

          const screenTrackSettings = videoTrack.getSettings();
          const screenBitratePolicy = getVideoBitratePolicy({
            profile: 'screen',
            width: screenTrackSettings.width ?? requestedScreenResolution.width,
            height:
              screenTrackSettings.height ?? requestedScreenResolution.height,
            frameRate: screenTrackSettings.frameRate ?? devices.screenFramerate,
            codecMimeType: preferredVideoCodec?.mimeType
          });

          localScreenShareProducer.current =
            await producerTransport.current?.produce({
              track: videoTrack,
              codecOptions: {
                videoGoogleStartBitrate: screenBitratePolicy.startKbps
              },
              codec: preferredVideoCodec,
              appData: { kind: StreamKind.SCREEN }
            });

          localScreenShareProducer.current?.on('@close', async () => {
            logVoice('Screen share producer closed');

            const trpc = getTRPCClient();

            try {
              await trpc.voice.closeProducer.mutate({
                kind: StreamKind.SCREEN
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

          if (
            audioMode === ScreenAudioMode.APP &&
            appAudioPipelineRef.current?.track
          ) {
            const appAudioTrack = appAudioPipelineRef.current.track;
            setLocalScreenShareAudio(appAudioPipelineRef.current.stream);

            localScreenShareAudioProducer.current =
              await producerTransport.current?.produce({
                track: appAudioTrack,
                appData: { kind: StreamKind.SCREEN_AUDIO }
              });

            appAudioTrack.onended = () => {
              localScreenShareAudioProducer.current?.close();
              localScreenShareAudioProducer.current = undefined;
              setLocalScreenShareAudio(undefined);

              void cleanupDesktopAppAudio({
                stopCapture: false
              });
            };
          } else if (audioTrack) {
            logVoice('Obtained audio track', { audioTrack });
            setLocalScreenShareAudio(new MediaStream([audioTrack]));

            localScreenShareAudioProducer.current =
              await producerTransport.current?.produce({
                track: audioTrack,
                appData: { kind: StreamKind.SCREEN_AUDIO }
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
      devices.videoCodec
    ]
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
    cleanupTransports
  ]);

  const init = useCallback(
    async (
      incomingRouterRtpCapabilities: RtpCapabilities,
      channelId: number
    ) => {
      logVoice('Initializing voice provider', {
        incomingRouterRtpCapabilities,
        channelId
      });

      cleanup();

      try {
        setLoading(true);
        setConnectionStatus(ConnectionStatus.CONNECTING);

        routerRtpCapabilities.current = incomingRouterRtpCapabilities;

        const device = new Device();

        await device.load({
          routerRtpCapabilities: incomingRouterRtpCapabilities
        });
        sendRtpCapabilities.current = device.rtpCapabilities;

        await createProducerTransport(device);
        await createConsumerTransport(device);
        await consumeExistingProducers(incomingRouterRtpCapabilities);
        await startMicStream();

        startMonitoring(producerTransport.current, consumerTransport.current);
        setConnectionStatus(ConnectionStatus.CONNECTED);
        setLoading(false);
        playSound(SoundType.OWN_USER_JOINED_VOICE_CHANNEL);
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
      consumerTransport
    ]
  );

  const {
    setMicMuted,
    toggleMic,
    toggleSound,
    toggleWebcam,
    toggleScreenShare
  } = useVoiceControls({
    startMicStream,
    localAudioStream,
    startWebcamStream,
    stopWebcamStream,
    startScreenShareStream,
    stopScreenShareStream,
    requestScreenShareSelection: getDesktopBridge()
      ? requestDesktopScreenShareSelection
      : undefined
  });

  const setMicMutedRef = useRef(setMicMuted);
  const ownMicMutedRef = useRef(ownVoiceState.micMuted);
  const currentVoiceChannelIdRef = useRef(currentVoiceChannelId);
  const canSpeakRef = useRef(channelCan(ChannelPermission.SPEAK));

  useEffect(() => {
    setMicMutedRef.current = setMicMuted;
  }, [setMicMuted]);

  useEffect(() => {
    ownMicMutedRef.current = ownVoiceState.micMuted;
  }, [ownVoiceState.micMuted]);

  useEffect(() => {
    currentVoiceChannelIdRef.current = currentVoiceChannelId;
    canSpeakRef.current = channelCan(ChannelPermission.SPEAK);
  }, [channelCan, currentVoiceChannelId]);

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
        playSound: false
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
        pushToMuteKeybind: devices.pushToMuteKeybind
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

    const removeGlobalKeybindSubscription =
      desktopBridge.subscribeGlobalPushKeybindEvents((event) => {
        if (
          currentVoiceChannelIdRef.current === undefined ||
          !canSpeakRef.current
        ) {
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
  }, [
    applyPushMicOverride,
    devices.pushToMuteKeybind,
    devices.pushToTalkKeybind
  ]);

  useEffect(() => {
    if (
      currentVoiceChannelId === undefined ||
      !channelCan(ChannelPermission.SPEAK)
    ) {
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
    rtpCapabilities: routerRtpCapabilities.current!
  });

  useEffect(() => {
    if (currentVoiceChannelId !== undefined) {
      clearPendingVoiceReconnectChannelId();
      return;
    }

    if (reconnectingVoiceRef.current) {
      return;
    }

    const pendingChannelId = consumePendingVoiceReconnectChannelId();

    if (pendingChannelId === undefined) {
      return;
    }

    reconnectingVoiceRef.current = true;

    void (async () => {
      try {
        const incomingRouterRtpCapabilities = await joinVoice(pendingChannelId);

        if (!incomingRouterRtpCapabilities) {
          return;
        }

        await init(incomingRouterRtpCapabilities, pendingChannelId);
      } catch (error) {
        logVoice('Failed to auto-rejoin previous voice channel', { error });
        toast.error('Failed to restore voice connection');
      } finally {
        reconnectingVoiceRef.current = false;
      }
    })();
  }, [currentVoiceChannelId, init]);

  useEffect(() => {
    return () => {
      logVoice('Voice provider unmounting, cleaning up resources');
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      pendingStreams
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
      pendingStreams
    ]
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
