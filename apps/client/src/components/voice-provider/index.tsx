import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useLog } from '@/hooks/use-log';
import { getTRPCClient } from '@/lib/trpc';
import { StreamKind, type RtpCapabilities } from '@sharkord/shared';
import { Device } from 'mediasoup-client';
import {
  type AppData,
  type Consumer,
  type Transport
} from 'mediasoup-client/types';
import {
  createContext,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState
} from 'react';
import { toast } from 'sonner';
import { useLocalStreams } from './hooks/use-local-streams';
import { useRemoteStreams } from './hooks/use-remote-streams';
import { useVoiceControls } from './hooks/use-voice-controls';
import {
  useVoiceEvents,
  type TNewProducerParams,
  type TProducerClosedParams,
  type TUserLeaveParams
} from './hooks/use-voice-events';

export type TVoiceProvider = {
  loading: boolean;
  init: (
    routerRtpCapabilities: RtpCapabilities,
    channelId: number
  ) => Promise<void>;
} & Pick<
  ReturnType<typeof useLocalStreams>,
  'localAudioStream' | 'localVideoStream' | 'localScreenShareStream'
> &
  Pick<ReturnType<typeof useRemoteStreams>, 'remoteStreams'> &
  ReturnType<typeof useVoiceControls>;

const VoiceProviderContext = createContext<TVoiceProvider>({
  loading: false,
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

  remoteStreams: {}
});

export { VoiceProviderContext };

type TVoiceProviderProps = {
  children: React.ReactNode;
};

const VoiceProvider = memo(({ children }: TVoiceProviderProps) => {
  const { log } = useLog();
  const [loading, setLoading] = useState(false);
  const routerRtpCapabilities = useRef<RtpCapabilities | null>(null);
  const producerTransport = useRef<Transport<AppData> | undefined>(undefined);
  const consumerTransport = useRef<Transport<AppData> | undefined>(undefined);
  const consumers = useRef<{
    [userId: number]: {
      [kind: string]: Consumer<AppData>;
    };
  }>({});

  const {
    addRemoteStream,
    removeRemoteStream,
    clearRemoteStreamsForUser,
    remoteStreams
  } = useRemoteStreams();
  const {
    localAudioProducer,
    localVideoProducer,
    localAudioStream,
    localVideoStream,
    localScreenShareStream,
    localScreenShareProducer,
    setLocalAudioStream,
    setLocalVideoStream,
    setLocalScreenShare
  } = useLocalStreams();

  const createProducerTransport = useCallback(
    async (device: Device) => {
      log('createProducerTransport() - creating producer transport');

      const trpc = getTRPCClient();

      try {
        const params = await trpc.voice.createProducerTransport.mutate();

        log('createProducerTransport() - requested producer transport', {
          params
        });

        producerTransport.current = device.createSendTransport(params);

        producerTransport.current.on(
          'connect',
          async ({ dtlsParameters }, callback, errback) => {
            log('producerTransport CONNECT', { dtlsParameters });

            try {
              await trpc.voice.connectProducerTransport.mutate({
                dtlsParameters
              });

              callback();
            } catch (error) {
              toast.error(
                getTrpcError(error, 'Failed to connect producer transport')
              );
              log('producerTransport CONNECT ERROR', { error });
              errback(error as Error);
            }
          }
        );

        producerTransport.current.on('connectionstatechange', (state) => {
          log('producerTransport CONNECTION STATE CHANGE', { state });

          if (['failed', 'disconnected', 'closed'].includes(state)) {
            producerTransport.current?.close();
            producerTransport.current = undefined;
          } else if (state === 'connected') {
            console.log('producerTransport connected');
          }
        });

        producerTransport.current.on('icecandidateerror', (error) => {
          log('producerTransport ICE CANDIDATE ERROR', { error });
        });

        producerTransport.current.on(
          'produce',
          async ({ rtpParameters, appData }, callback, errback) => {
            log('producerTransport PRODUCE', { rtpParameters, appData });

            const { kind } = appData as { kind: StreamKind };

            if (!producerTransport.current) return;

            try {
              const producerId = await trpc.voice.produce.mutate({
                transportId: producerTransport.current.id,
                kind,
                rtpParameters
              });

              callback({ id: producerId });
            } catch (error) {
              errback(error as Error);
            }
          }
        );
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to create producer transport'));
      }
    },
    [log]
  );

  const createConsumerTransport = useCallback(
    async (device: Device) => {
      log('createConsumerTransport() - creating consumer transport');

      const trpc = getTRPCClient();

      try {
        const params = await trpc.voice.createConsumerTransport.mutate();

        log('createConsumerTransport() - requested consumer transport', {
          params
        });

        consumerTransport.current = device.createRecvTransport(params);

        consumerTransport.current.on(
          'connect',
          async ({ dtlsParameters }, callback, errback) => {
            log('consumerTransport CONNECT', { dtlsParameters });

            try {
              await trpc.voice.connectConsumerTransport.mutate({
                dtlsParameters
              });

              callback();
            } catch (error) {
              toast.error(
                getTrpcError(error, 'Failed to connect consumer transport')
              );
              log('consumerTransport CONNECT ERROR', { error });
              errback(error as Error);
            }
          }
        );
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to create consumer transport'));
        return;
      }
    },
    [log]
  );

  const consume = useCallback(
    async (
      remoteUserId: number,
      kind: StreamKind,
      routerRtpCapabilities: RtpCapabilities
    ) => {
      if (!consumerTransport.current) return;

      log('consume()', {
        remoteUserId,
        kind,
        routerRtpCapabilities
      });

      const trpc = getTRPCClient();

      try {
        const { producerId, consumerId, consumerKind, consumerRtpParameters } =
          await trpc.voice.consume.mutate({
            kind,
            remoteUserId,
            rtpCapabilities: routerRtpCapabilities
          });

        if (!consumers.current[remoteUserId]) {
          consumers.current[remoteUserId] = {};
        }

        const existingConsumer = consumers.current[remoteUserId][consumerKind];

        if (existingConsumer) {
          existingConsumer.close();
          delete consumers.current[remoteUserId][consumerKind];
        }

        const targetKind =
          consumerKind === StreamKind.SCREEN ? StreamKind.VIDEO : consumerKind;

        const newConsumer = await consumerTransport.current.consume({
          id: consumerId,
          producerId: producerId,
          kind: targetKind,
          rtpParameters: consumerRtpParameters
        });

        const cleanupEvents = [
          'transportclose',
          'trackended',
          '@close',
          'close'
        ];

        cleanupEvents.forEach((event) => {
          // @ts-expect-error - YOLO
          newConsumer?.on(event, () => {
            removeRemoteStream(remoteUserId, kind);
          });
        });

        consumers.current[remoteUserId][consumerKind] = newConsumer;

        const stream = new MediaStream();

        stream.addTrack(newConsumer.track);

        addRemoteStream(remoteUserId, stream, kind);
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to consume remote producer'));
      }
    },
    [log, addRemoteStream, removeRemoteStream]
  );

  const consumeExistingProducers = useCallback(
    async (routerRtpCapabilities: RtpCapabilities) => {
      log('consumeExistingProducers() - consuming existing producers', {
        routerRtpCapabilities
      });

      const trpc = getTRPCClient();

      try {
        const { remoteAudioIds, remoteScreenIds, remoteVideoIds } =
          await trpc.voice.getProducers.query();

        log('consumeExistingProducers() - existing producers', {
          remoteAudioIds,
          remoteScreenIds,
          remoteVideoIds
        });

        remoteAudioIds.forEach((remoteId) => {
          consume(remoteId, StreamKind.AUDIO, routerRtpCapabilities);
        });

        remoteVideoIds.forEach((remoteId) => {
          consume(remoteId, StreamKind.VIDEO, routerRtpCapabilities);
        });

        remoteScreenIds.forEach((remoteId) => {
          consume(remoteId, StreamKind.SCREEN, routerRtpCapabilities);
        });
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to get existing producers'));
      }
    },
    [log, consume]
  );

  const startMicStream = useCallback(async () => {
    log('startMicStream() - requesting user media');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 48000,
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });

    log('startMicStream() - obtained user media', { stream });

    setLocalAudioStream(stream);

    const audioTrack = stream.getAudioTracks()[0];

    log('startMicStream() - obtained audio track', { audioTrack });

    if (audioTrack) {
      localAudioProducer.current = await producerTransport.current?.produce({
        track: audioTrack,
        appData: { kind: StreamKind.AUDIO }
      });
    }
  }, [producerTransport, log, setLocalAudioStream, localAudioProducer]);

  const startWebcamStream = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: true
    });

    setLocalVideoStream(stream);

    const videoTrack = stream.getVideoTracks()[0];

    if (videoTrack) {
      localVideoProducer.current = await producerTransport.current?.produce({
        track: videoTrack,
        appData: { kind: StreamKind.VIDEO }
      });

      localVideoProducer.current?.on('@close', async () => {
        const trpc = getTRPCClient();

        try {
          await trpc.voice.closeProducer.mutate();
        } catch (error) {
          toast.error(getTrpcError(error, 'Failed to close video producer'));
        }
      });
    }
  }, [setLocalVideoStream, localVideoProducer]);

  const stopWebcamStream = useCallback(() => {
    localVideoStream?.getVideoTracks().forEach((track) => {
      track.stop();
      localVideoStream.removeTrack(track);
    });

    localVideoProducer.current?.close();
    localVideoProducer.current = undefined;

    setLocalVideoStream(undefined);
  }, [localVideoStream, setLocalVideoStream, localVideoProducer]);

  const stopScreenShareStream = useCallback(() => {
    localScreenShareStream?.getTracks().forEach((track) => {
      track.stop();
      localScreenShareStream.removeTrack(track);
    });

    localScreenShareProducer.current?.close();
    localScreenShareProducer.current = undefined;

    setLocalScreenShare(undefined);
  }, [localScreenShareStream, setLocalScreenShare, localScreenShareProducer]);

  const startScreenShareStream = useCallback(async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 60
      },
      audio: true
    });

    setLocalScreenShare(stream);

    const videoTrack = stream.getVideoTracks()[0];

    if (videoTrack) {
      localScreenShareProducer.current =
        await producerTransport.current?.produce({
          track: videoTrack,
          appData: { kind: StreamKind.SCREEN }
        });

      localScreenShareProducer.current?.on('@close', async () => {
        const trpc = getTRPCClient();

        try {
          await trpc.voice.closeProducer.mutate();
        } catch (error) {
          toast.error(
            getTrpcError(error, 'Failed to close screen share producer')
          );
        }
      });
    }

    if (!videoTrack) {
      throw new Error('No video track obtained for screen share');
    }

    return videoTrack;
  }, [setLocalScreenShare, localScreenShareProducer]);

  const init = useCallback(
    async (
      incomingRouterRtpCapabilities: RtpCapabilities,
      channelId: number
    ) => {
      console.log('mediaSoup init()', { routerRtpCapabilities, channelId });

      setLoading(true);
      routerRtpCapabilities.current = incomingRouterRtpCapabilities;

      const device = new Device();
      await device.load({
        routerRtpCapabilities: incomingRouterRtpCapabilities
      });

      device.observer.on('newtransport', (...data) => {
        log('device newtransport', { data });
      });

      await createProducerTransport(device);
      await createConsumerTransport(device);
      await consumeExistingProducers(incomingRouterRtpCapabilities);
      await startMicStream();

      setLoading(false);
    },
    [
      createProducerTransport,
      createConsumerTransport,
      consumeExistingProducers,
      startMicStream,
      log
    ]
  );

  const {
    toggleMic,
    toggleSound,
    toggleWebcam,
    toggleScreenShare,
    ownVoiceState
  } = useVoiceControls({
    startMicStream,
    localAudioStream,
    startWebcamStream,
    stopWebcamStream,
    startScreenShareStream,
    stopScreenShareStream
  });

  const onNewProducer = useCallback<TNewProducerParams>(
    ({ remoteUserId, kind }) => {
      log('VoiceProvider onNewProducer', { remoteUserId, kind });
      consume(remoteUserId, kind, routerRtpCapabilities.current!);
    },
    [consume, log]
  );

  const onProducerClosed = useCallback<TProducerClosedParams>(
    ({ remoteUserId, kind }) => {
      log('VoiceProvider onProducerClosed', { remoteUserId, kind });
      removeRemoteStream(remoteUserId, kind);
    },
    [removeRemoteStream, log]
  );

  const onUserLeave = useCallback<TUserLeaveParams>(
    ({ userId }) => {
      log('VoiceProvider onUserLeave', { userId });
      clearRemoteStreamsForUser(userId);
    },
    [clearRemoteStreamsForUser, log]
  );

  // TODO: move these into the hook
  useVoiceEvents({
    onNewProducer,
    onProducerClosed,
    onUserLeave
  });

  // const cleanup = useCallback(() => {
  //   if (producerTransport.current) {
  //     producerTransport.current.close();
  //     producerTransport.current = undefined;
  //   }

  //   if (consumerTransport.current) {
  //     consumerTransport.current.close();
  //     consumerTransport.current = undefined;
  //   }

  //   Object.keys(consumers.current).forEach((userId) => {
  //     const userConsumers = consumers.current[userId];

  //     Object.keys(userConsumers).forEach((kind) => {
  //       userConsumers[kind].close();
  //     });
  //   });

  //   consumers.current = {};

  //   setLoading(true);
  //   clearRemoteStreams();
  //   clearLocalStreams();
  // }, [clearLocalStreams, clearRemoteStreams]);

  // useEffect(() => {
  //   return () => {
  //     cleanup();
  //   };
  // }, [cleanup]);

  const contextValue = useMemo<TVoiceProvider>(
    () => ({
      loading,
      init,

      toggleMic,
      toggleSound,
      toggleWebcam,
      toggleScreenShare,
      ownVoiceState,

      localAudioStream,
      localVideoStream,
      localScreenShareStream,

      remoteStreams
    }),
    [
      loading,
      init,

      toggleMic,
      toggleSound,
      toggleWebcam,
      toggleScreenShare,
      ownVoiceState,

      localAudioStream,
      localVideoStream,
      localScreenShareStream,
      remoteStreams
    ]
  );

  return (
    <VoiceProviderContext.Provider value={contextValue}>
      {children}
    </VoiceProviderContext.Provider>
  );
});

export { VoiceProvider };
