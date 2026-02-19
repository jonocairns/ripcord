import type { TAppAudioFrame, TAppAudioSession } from '@/runtime/types';
import desktopAppAudioWorkletModuleUrl from './desktop-app-audio.worklet.js?url';

type TDesktopAppAudioPipeline = {
  sessionId: string;
  stream: MediaStream;
  track: MediaStreamTrack;
  pushFrame: (frame: TAppAudioFrame) => void;
  destroy: () => Promise<void>;
};

type TDesktopAppAudioPipelineMode = 'low-latency' | 'stable';

type TDesktopAppAudioPipelineOptions = {
  mode?: TDesktopAppAudioPipelineMode;
  logLabel?: string;
  insertSilenceOnDroppedFrames?: boolean;
};

const WORKLET_NAME = 'sharkord-pcm-queue-processor';
const LOW_LATENCY_TARGET_CHUNKS = 4;
const LOW_LATENCY_MAX_CHUNKS = 8;
const STABLE_TARGET_CHUNKS = 12;
const STABLE_MAX_CHUNKS = 24;
const MAX_RECOVERABLE_DROPPED_FRAMES = 50;

const decodePcmBase64 = (pcmBase64: string): Float32Array => {
  const binaryString = atob(pcmBase64);
  const byteLength = binaryString.length;
  const bytes = new Uint8Array(byteLength);

  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  return new Float32Array(bytes.buffer);
};

const ensureWorkletModule = async (audioContext: AudioContext) => {
  await audioContext.audioWorklet.addModule(desktopAppAudioWorkletModuleUrl);
};

const createDesktopAppAudioPipeline = async (
  session: TAppAudioSession,
  options?: TDesktopAppAudioPipelineOptions
): Promise<TDesktopAppAudioPipeline> => {
  const mode = options?.mode || 'low-latency';
  const logLabel = options?.logLabel || 'desktop-app-audio';
  const insertSilenceOnDroppedFrames =
    options?.insertSilenceOnDroppedFrames ?? false;
  const targetChunks =
    mode === 'stable' ? STABLE_TARGET_CHUNKS : LOW_LATENCY_TARGET_CHUNKS;
  const maxChunks = mode === 'stable' ? STABLE_MAX_CHUNKS : LOW_LATENCY_MAX_CHUNKS;
  const trimQueueForLowLatency = mode === 'low-latency';

  const audioContext = new AudioContext({
    sampleRate: session.sampleRate,
    latencyHint: 'interactive'
  });

  await ensureWorkletModule(audioContext);

  const outputChannels = Math.max(1, session.channels);
  const destinationNode = audioContext.createMediaStreamDestination();
  const workletNode = new AudioWorkletNode(audioContext, WORKLET_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [outputChannels],
    processorOptions: {
      channels: outputChannels,
      targetChunks,
      maxChunks,
      trimQueueForLowLatency
    }
  });

  workletNode.connect(destinationNode);

  workletNode.port.onmessage = (event) => {
    const data = event.data;

    if (data?.type === 'queue-overflow') {
      console.warn(`[${logLabel}] PCM queue overflow`, data);
      return;
    }

    if (data?.type === 'queue-trim') {
      console.warn(`[${logLabel}] PCM queue trimmed for low latency`, data);
    }
  };

  if (audioContext.state !== 'running') {
    await audioContext.resume();
  }

  const track = destinationNode.stream.getAudioTracks()[0];

  if (!track) {
    throw new Error('Failed to create MediaStreamTrack from app audio pipeline');
  }

  return {
    sessionId: session.sessionId,
    stream: destinationNode.stream,
    track,
    pushFrame: (frame) => {
      if (frame.sessionId !== session.sessionId) {
        return;
      }

      if (frame.protocolVersion !== 1) {
        console.warn(
          `[${logLabel}] Unsupported app audio protocol version`,
          frame.protocolVersion
        );
        return;
      }

      if (frame.encoding !== 'f32le_base64') {
        console.warn(
          `[${logLabel}] Unsupported app audio frame encoding`,
          frame.encoding
        );
        return;
      }

      const droppedFrameCount = frame.droppedFrameCount || 0;
      if (droppedFrameCount > 0) {
        console.warn(`[${logLabel}] Sidecar dropped frames`, {
          droppedFrameCount
        });

        if (insertSilenceOnDroppedFrames) {
          const recoverableDroppedFrames = Math.min(
            droppedFrameCount,
            MAX_RECOVERABLE_DROPPED_FRAMES
          );
          const silenceFrameCount = recoverableDroppedFrames * frame.frameCount;
          const silence = new Float32Array(silenceFrameCount * outputChannels);

          workletNode.port.postMessage(
            {
              type: 'pcm',
              samples: silence
            },
            [silence.buffer]
          );

          if (recoverableDroppedFrames !== droppedFrameCount) {
            console.warn(`[${logLabel}] Dropped frame recovery was capped`, {
              droppedFrameCount,
              recoverableDroppedFrames
            });
          }
        }
      }

      const samples = decodePcmBase64(frame.pcmBase64);
      workletNode.port.postMessage(
        {
          type: 'pcm',
          samples
        },
        [samples.buffer]
      );
    },
    destroy: async () => {
      try {
        workletNode.port.postMessage({
          type: 'reset'
        });
        workletNode.disconnect();
      } catch {
        // ignore
      }

      track.stop();
      await audioContext.close();
    }
  };
};

export { createDesktopAppAudioPipeline };
export type {
  TDesktopAppAudioPipeline,
  TDesktopAppAudioPipelineMode,
  TDesktopAppAudioPipelineOptions
};
