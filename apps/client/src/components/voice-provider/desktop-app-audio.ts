import type {
  TAppAudioSession
} from '@/runtime/types';
import desktopAppAudioWorkletModuleUrl from './desktop-app-audio.worklet.js?url&no-inline';
import {
  computeRecoverableMissingFrameCount,
  isPcmFrame,
  type TDesktopAppAudioFrame,
  validateDesktopAppAudioFrame
} from './desktop-app-audio-frame-policy';

type TDesktopAppAudioPipeline = {
  sessionId: string;
  stream: MediaStream;
  track: MediaStreamTrack;
  pushFrame: (frame: TDesktopAppAudioFrame) => void;
  destroy: () => Promise<void>;
};

type TDesktopAppAudioPipelineMode = 'low-latency' | 'stable';

type TDesktopAppAudioPipelineOptions = {
  mode?: TDesktopAppAudioPipelineMode;
  logLabel?: string;
  insertSilenceOnDroppedFrames?: boolean;
  emitQueueTelemetry?: boolean;
  queueTelemetryIntervalMs?: number;
};

const WORKLET_NAME = 'sharkord-pcm-queue-processor';
const LOW_LATENCY_TARGET_CHUNKS = 6;
const LOW_LATENCY_TRIM_START_CHUNKS = 10;
const LOW_LATENCY_MAX_CHUNKS = 16;
const STABLE_TARGET_CHUNKS = 12;
const STABLE_MAX_CHUNKS = 24;
const LOG_RATE_LIMIT_MS = 2_000;
const TELEMETRY_LOG_INTERVAL_MS = 10_000;

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
  const emitQueueTelemetry = options?.emitQueueTelemetry ?? false;
  const queueTelemetryIntervalMs = Math.max(
    250,
    Math.floor(options?.queueTelemetryIntervalMs ?? 1_000)
  );
  const targetChunks =
    mode === 'stable' ? STABLE_TARGET_CHUNKS : LOW_LATENCY_TARGET_CHUNKS;
  const trimStartChunks =
    mode === 'stable' ? STABLE_MAX_CHUNKS : LOW_LATENCY_TRIM_START_CHUNKS;
  const maxChunks = mode === 'stable' ? STABLE_MAX_CHUNKS : LOW_LATENCY_MAX_CHUNKS;
  const trimQueueForLowLatency = mode === 'low-latency';
  let nextQueueOverflowLogAt = 0;
  let suppressedQueueOverflowEvents = 0;
  let nextQueueTrimLogAt = 0;
  let suppressedQueueTrimEvents = 0;
  let nextDroppedFrameLogAt = 0;
  let droppedFrameEventsSinceLastLog = 0;
  let droppedFramesSinceLastLog = 0;
  let nextMalformedFrameLogAt = 0;
  let malformedFrameDropsSinceLastLog = 0;
  let nextSequenceAnomalyLogAt = 0;
  let sequenceAnomaliesSinceLastLog = 0;
  let nextQueueTelemetryLogAt = 0;
  let lastSequence: number | undefined;

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
      trimStartChunks,
      maxChunks,
      trimQueueForLowLatency,
      emitQueueTelemetry,
      queueTelemetryIntervalMs
    }
  });

  workletNode.connect(destinationNode);

  workletNode.port.onmessage = (event) => {
    const data = event.data;

    if (data?.type === 'queue-overflow') {
      const now = Date.now();
      suppressedQueueOverflowEvents += 1;
      if (now >= nextQueueOverflowLogAt) {
        console.warn(`[${logLabel}] PCM queue overflow`, {
          ...data,
          eventsSinceLastLog: suppressedQueueOverflowEvents
        });
        suppressedQueueOverflowEvents = 0;
        nextQueueOverflowLogAt = now + LOG_RATE_LIMIT_MS;
      }

      return;
    }

    if (data?.type === 'queue-trim') {
      const now = Date.now();
      suppressedQueueTrimEvents += 1;
      if (now >= nextQueueTrimLogAt) {
        console.warn(`[${logLabel}] PCM queue trimmed for low latency`, {
          ...data,
          eventsSinceLastLog: suppressedQueueTrimEvents
        });
        suppressedQueueTrimEvents = 0;
        nextQueueTrimLogAt = now + LOG_RATE_LIMIT_MS;
      }
      return;
    }

    if (data?.type === 'queue-stats' && emitQueueTelemetry) {
      const now = Date.now();
      if (now >= nextQueueTelemetryLogAt) {
        console.info(`[${logLabel}] PCM queue telemetry`, data);
        nextQueueTelemetryLogAt = now + TELEMETRY_LOG_INTERVAL_MS;
      }
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
      const frameValidation = validateDesktopAppAudioFrame({
        frame,
        sessionId: session.sessionId,
        sessionSampleRate: session.sampleRate,
        outputChannels,
        lastSequence
      });

      if (!frameValidation.accepted) {
        switch (frameValidation.reason) {
          case 'session-mismatch':
            return;
          case 'unsupported-protocol':
            console.warn(
              `[${logLabel}] Unsupported app audio protocol version`,
              frame.protocolVersion
            );
            return;
          case 'unsupported-encoding':
            console.warn(
              `[${logLabel}] Unsupported app audio frame encoding`,
              'encoding' in frame ? frame.encoding : undefined
            );
            return;
          case 'sample-rate-mismatch': {
            const now = Date.now();
            malformedFrameDropsSinceLastLog += 1;
            if (now >= nextMalformedFrameLogAt) {
              console.warn(
                `[${logLabel}] Dropping app audio frame with sample-rate mismatch`,
                {
                  frameSampleRate: frame.sampleRate,
                  expectedSampleRate: session.sampleRate,
                  malformedFrameDropsSinceLastLog
                }
              );
              malformedFrameDropsSinceLastLog = 0;
              nextMalformedFrameLogAt = now + LOG_RATE_LIMIT_MS;
            }
            return;
          }
          case 'invalid-sequence': {
            const now = Date.now();
            malformedFrameDropsSinceLastLog += 1;
            if (now >= nextMalformedFrameLogAt) {
              console.warn(`[${logLabel}] Dropping app audio frame with invalid sequence`, {
                sequence: frame.sequence,
                malformedFrameDropsSinceLastLog
              });
              malformedFrameDropsSinceLastLog = 0;
              nextMalformedFrameLogAt = now + LOG_RATE_LIMIT_MS;
            }
            return;
          }
          case 'out-of-order-sequence': {
            const now = Date.now();
            sequenceAnomaliesSinceLastLog += 1;
            if (now >= nextSequenceAnomalyLogAt) {
              console.warn(`[${logLabel}] Dropping out-of-order app audio frame`, {
                sequence: frame.sequence,
                lastSequence,
                sequenceAnomaliesSinceLastLog
              });
              sequenceAnomaliesSinceLastLog = 0;
              nextSequenceAnomalyLogAt = now + LOG_RATE_LIMIT_MS;
            }
            return;
          }
          case 'malformed-header': {
            const now = Date.now();
            malformedFrameDropsSinceLastLog += 1;
            if (now >= nextMalformedFrameLogAt) {
              console.warn(`[${logLabel}] Dropping malformed app audio frame header`, {
                channels: frame.channels,
                frameCount: frame.frameCount,
                malformedFrameDropsSinceLastLog
              });
              malformedFrameDropsSinceLastLog = 0;
              nextMalformedFrameLogAt = now + LOG_RATE_LIMIT_MS;
            }
            return;
          }
          case 'channel-mismatch': {
            const now = Date.now();
            malformedFrameDropsSinceLastLog += 1;
            if (now >= nextMalformedFrameLogAt) {
              console.warn(`[${logLabel}] Dropping app audio frame with channel mismatch`, {
                frameChannels: frame.channels,
                outputChannels,
                malformedFrameDropsSinceLastLog
              });
              malformedFrameDropsSinceLastLog = 0;
              nextMalformedFrameLogAt = now + LOG_RATE_LIMIT_MS;
            }
            return;
          }
        }
      }

      const { droppedFrameCount, missingFrameCount, sequenceGapFrames } =
        frameValidation;

      if (missingFrameCount > 0) {
        const now = Date.now();
        droppedFrameEventsSinceLastLog += 1;
        droppedFramesSinceLastLog += missingFrameCount;

        if (now >= nextDroppedFrameLogAt) {
          console.warn(`[${logLabel}] Missing app audio frames detected`, {
            droppedFrameCount,
            sequenceGapFrames,
            droppedFramesSinceLastLog,
            droppedFrameEventsSinceLastLog
          });
          droppedFrameEventsSinceLastLog = 0;
          droppedFramesSinceLastLog = 0;
          nextDroppedFrameLogAt = now + LOG_RATE_LIMIT_MS;
        }

        if (insertSilenceOnDroppedFrames) {
          const recoverableDroppedFrames =
            computeRecoverableMissingFrameCount(missingFrameCount);
          const silenceFrameCount = recoverableDroppedFrames * frame.frameCount;
          const silence = new Float32Array(silenceFrameCount * outputChannels);

          workletNode.port.postMessage(
            {
              type: 'pcm',
              samples: silence
            },
            [silence.buffer]
          );

          if (recoverableDroppedFrames !== missingFrameCount) {
            console.warn(`[${logLabel}] Missing frame recovery was capped`, {
              missingFrameCount,
              recoverableDroppedFrames
            });
          }
        }
      }

      const samples = isPcmFrame(frame)
        ? frame.pcm
        : decodePcmBase64(frame.pcmBase64);

      const expectedSampleCount = frame.frameCount * frame.channels;
      if (samples.length !== expectedSampleCount) {
        const now = Date.now();
        malformedFrameDropsSinceLastLog += 1;
        if (now >= nextMalformedFrameLogAt) {
          console.warn(`[${logLabel}] Dropping malformed app audio frame payload`, {
            expectedSampleCount,
            actualSampleCount: samples.length,
            frameCount: frame.frameCount,
            channels: frame.channels,
            malformedFrameDropsSinceLastLog
          });
          malformedFrameDropsSinceLastLog = 0;
          nextMalformedFrameLogAt = now + LOG_RATE_LIMIT_MS;
        }
        return;
      }

      workletNode.port.postMessage(
        {
          type: 'pcm',
          samples
        },
        [samples.buffer]
      );
      lastSequence = frame.sequence;
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
