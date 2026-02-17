import { requestScreenShareSelection as requestScreenShareSelectionDialog } from '@/features/dialogs/actions';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import { logVoice } from '@/helpers/browser-logger';
import { getResWidthHeight } from '@/helpers/get-res-with-height';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import {
  ScreenAudioMode,
  type TAppAudioStatusEvent,
  type TAppAudioSession,
  type TDesktopScreenShareSelection
} from '@/runtime/types';
import { StreamKind, type TVoiceUserState } from '@sharkord/shared';
import { Device } from 'mediasoup-client';
import type { RtpCapabilities } from 'mediasoup-client/types';
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
import { useRemoteStreams } from './hooks/use-remote-streams';
import {
  useTransportStats,
  type TransportStatsData
} from './hooks/use-transport-stats';
import { useTransports } from './hooks/use-transports';
import { useVoiceControls } from './hooks/use-voice-controls';
import { useVoiceEvents } from './hooks/use-voice-events';
import { VolumeControlProvider } from './volume-control-context';

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

export type TVoiceProvider = {
  loading: boolean;
  connectionStatus: ConnectionStatus;
  transportStats: TransportStatsData;
  audioVideoRefsMap: Map<number, AudioVideoRefs>;
  ownVoiceState: TVoiceUserState;
  getOrCreateRefs: (remoteId: number) => AudioVideoRefs;
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
  init: () => Promise.resolve(),
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
  externalStreams: {}
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
  const audioVideoRefsMap = useRef<Map<number, AudioVideoRefs>>(new Map());
  const ownVoiceState = useOwnVoiceState();
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
  const standbyDisplayAudioTrackRef = useRef<MediaStreamTrack | undefined>(
    undefined
  );
  const standbyDisplayAudioStreamRef = useRef<MediaStream | undefined>(
    undefined
  );

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
    cleanupTransports
  } = useTransports({
    addExternalStreamTrack,
    removeExternalStreamTrack,
    addRemoteUserStream,
    removeRemoteUserStream
  });

  const {
    stats: transportStats,
    startMonitoring,
    stopMonitoring,
    resetStats
  } = useTransportStats();

  const startMicStream = useCallback(async () => {
    try {
      logVoice('Starting microphone stream');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: {
            exact: devices.microphoneId
          },
          autoGainControl: devices.autoGainControl,
          echoCancellation: devices.echoCancellation,
          noiseSuppression: devices.noiseSuppression,
          sampleRate: 48000,
          channelCount: 2
        },
        video: false
      });

      logVoice('Microphone stream obtained', { stream });

      setLocalAudioStream(stream);

      const audioTrack = stream.getAudioTracks()[0];

      if (audioTrack) {
        audioTrack.enabled = !ownVoiceState.micMuted;

        logVoice('Obtained audio track', { audioTrack });

        localAudioProducer.current = await producerTransport.current?.produce({
          track: audioTrack,
          appData: { kind: StreamKind.AUDIO }
        });

        logVoice('Microphone audio producer created', {
          producer: localAudioProducer.current
        });

        localAudioProducer.current?.on('@close', async () => {
          logVoice('Audio producer closed');

          const trpc = getTRPCClient();

          try {
            await trpc.voice.closeProducer.mutate({
              kind: StreamKind.AUDIO
            });
          } catch (error) {
            logVoice('Error closing audio producer', { error });
          }
        });

        audioTrack.onended = () => {
          logVoice('Audio track ended, cleaning up microphone');

          localAudioStream?.getAudioTracks().forEach((track) => {
            track.stop();
          });
          localAudioProducer.current?.close();

          setLocalAudioStream(undefined);
        };
      } else {
        throw new Error('Failed to obtain audio track from microphone');
      }
    } catch (error) {
      logVoice('Error starting microphone stream', { error });
    }
  }, [
    producerTransport,
    setLocalAudioStream,
    localAudioProducer,
    localAudioStream,
    devices.microphoneId,
    devices.autoGainControl,
    devices.echoCancellation,
    devices.noiseSuppression,
    ownVoiceState.micMuted
  ]);

  const startWebcamStream = useCallback(async () => {
    try {
      logVoice('Starting webcam stream');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: devices?.webcamId },
          frameRate: devices.webcamFramerate,
          ...getResWidthHeight(devices?.webcamResolution)
        }
      });

      logVoice('Webcam stream obtained', { stream });

      setLocalVideoStream(stream);

      const videoTrack = stream.getVideoTracks()[0];

      if (videoTrack) {
        logVoice('Obtained video track', { videoTrack });

        localVideoProducer.current = await producerTransport.current?.produce({
          track: videoTrack,
          appData: { kind: StreamKind.VIDEO }
        });

        logVoice('Webcam video producer created', {
          producer: localVideoProducer.current
        });

        localVideoProducer.current?.on('@close', async () => {
          logVoice('Video producer closed');

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

          localVideoStream?.getVideoTracks().forEach((track) => {
            track.stop();
          });
          localVideoProducer.current?.close();

          setLocalVideoStream(undefined);
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
    localVideoStream,
    devices.webcamId,
    devices.webcamFramerate,
    devices.webcamResolution
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

  const cleanupDesktopAppAudio = useCallback(
    async ({
      stopCapture = true,
      preserveCurrentAudio = false
    }: {
      stopCapture?: boolean;
      preserveCurrentAudio?: boolean;
    } = {}) => {
      const desktopBridge = getDesktopBridge();

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

  const activateDisplayAudioFallback = useCallback(
    async (reason: TAppAudioStatusEvent['reason']) => {
      const standbyTrack = standbyDisplayAudioTrackRef.current;

      if (!standbyTrack || standbyTrack.readyState !== 'live') {
        return false;
      }

      const standbyStream =
        standbyDisplayAudioStreamRef.current || new MediaStream([standbyTrack]);
      standbyDisplayAudioStreamRef.current = standbyStream;

      localScreenShareAudioProducer.current?.close();
      localScreenShareAudioProducer.current = undefined;

      const producer = await producerTransport.current?.produce({
        track: standbyTrack,
        appData: { kind: StreamKind.SCREEN_AUDIO }
      });

      if (!producer) {
        return false;
      }

      localScreenShareAudioProducer.current = producer;
      setLocalScreenShareAudio(standbyStream);

      standbyTrack.onended = () => {
        localScreenShareAudioProducer.current?.close();
        localScreenShareAudioProducer.current = undefined;
        setLocalScreenShareAudio(undefined);
        standbyDisplayAudioTrackRef.current = undefined;
        standbyDisplayAudioStreamRef.current = undefined;
      };

      toast.warning(
        `Per-app audio ended (${reason}). Switched to system audio fallback.`
      );

      return true;
    },
    [
      localScreenShareAudioProducer,
      producerTransport,
      setLocalScreenShareAudio
    ]
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
          desktopBridge.getCapabilities({
            experimentalRustCapture: devices.experimentalRustCapture
          })
        ]);

        if (sources.length === 0) {
          toast.error('No windows or screens were detected for sharing.');
          return null;
        }

        return requestScreenShareSelectionDialog({
          sources,
          capabilities,
          defaultAudioMode: devices.screenAudioMode,
          experimentalRustCapture: devices.experimentalRustCapture
        });
      } catch (error) {
        logVoice('Failed to open desktop screen share picker', { error });
        toast.error('Failed to load shareable sources.');
        return null;
      }
    }, [devices.experimentalRustCapture, devices.screenAudioMode]);

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
          audioMode === ScreenAudioMode.APP &&
          devices.experimentalRustCapture
        ) {
          try {
            const appAudioSession = await desktopBridge.startAppAudioCapture({
              sourceId: desktopSelection.sourceId,
              appAudioTargetId: desktopSelection.appAudioTargetId
            });
            const appAudioPipeline =
              await createDesktopAppAudioPipeline(appAudioSession);

            appAudioSessionRef.current = appAudioSession;
            appAudioPipelineRef.current = appAudioPipeline;

            removeAppAudioFrameSubscriptionRef.current?.();
            removeAppAudioFrameSubscriptionRef.current =
              desktopBridge.subscribeAppAudioFrames((frame) => {
                appAudioPipelineRef.current?.pushFrame(frame);
              });

            removeAppAudioStatusSubscriptionRef.current?.();
            removeAppAudioStatusSubscriptionRef.current =
              desktopBridge.subscribeAppAudioStatus(
                (statusEvent: TAppAudioStatusEvent) => {
                  if (
                    statusEvent.sessionId !== appAudioSessionRef.current?.sessionId
                  ) {
                    return;
                  }

                  void (async () => {
                    const switched = await activateDisplayAudioFallback(
                      statusEvent.reason
                    );

                    if (!switched) {
                      toast.warning(
                        'Per-app audio capture ended and no fallback audio is available. Screen video will continue without shared audio.'
                      );
                      localScreenShareAudioProducer.current?.close();
                      localScreenShareAudioProducer.current = undefined;
                      setLocalScreenShareAudio(undefined);
                    }

                    await cleanupDesktopAppAudio({
                      stopCapture: false,
                      preserveCurrentAudio: switched
                    });
                  })();
                }
              );
          } catch (error) {
            logVoice('Failed to start per-app sidecar audio capture', { error });
            toast.warning(
              'Per-app audio capture failed. Falling back to system audio.'
            );
            await cleanupDesktopAppAudio();
            audioMode = ScreenAudioMode.SYSTEM;
          }
        }

        const shouldCaptureDisplayAudio =
          audioMode === ScreenAudioMode.SYSTEM ||
          audioMode === ScreenAudioMode.APP;

        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            ...getResWidthHeight(devices?.screenResolution),
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
          standbyDisplayAudioTrackRef.current = audioTrack;
          standbyDisplayAudioStreamRef.current = new MediaStream([audioTrack]);
        } else {
          standbyDisplayAudioTrackRef.current = undefined;
          standbyDisplayAudioStreamRef.current = undefined;
        }

        if (videoTrack) {
          logVoice('Obtained video track', { videoTrack });

          localScreenShareProducer.current =
            await producerTransport.current?.produce({
              track: videoTrack,
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
      activateDisplayAudioFallback,
      setLocalScreenShare,
      localScreenShareProducer,
      localScreenShareAudioProducer,
      producerTransport,
      localScreenShareStream,
      setLocalScreenShareAudio,
      devices.experimentalRustCapture,
      devices.screenAudioMode,
      devices.screenResolution,
      devices.screenFramerate
    ]
  );

  const cleanup = useCallback(() => {
    logVoice('Running voice provider cleanup');

    void cleanupDesktopAppAudio();
    stopMonitoring();
    resetStats();
    clearLocalStreams();
    clearRemoteUserStreams();
    clearExternalStreams();
    cleanupTransports();

    setConnectionStatus(ConnectionStatus.DISCONNECTED);
  }, [
    stopMonitoring,
    resetStats,
    cleanupDesktopAppAudio,
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

  const { toggleMic, toggleSound, toggleWebcam, toggleScreenShare } =
    useVoiceControls({
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

  useVoiceEvents({
    consume,
    removeRemoteUserStream,
    removeExternalStreamTrack,
    removeExternalStream,
    clearRemoteUserStreamsForUser,
    rtpCapabilities: routerRtpCapabilities.current!
  });

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
      init,

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
      externalStreams
    }),
    [
      loading,
      connectionStatus,
      transportStats,
      getOrCreateRefs,
      init,

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
      externalStreams
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
