import { getDesktopBridge } from '@/runtime/desktop-bridge';
import type {
  TVoiceFilterFrame,
  TVoiceFilterStatusEvent,
  TVoiceFilterStrength as TRuntimeVoiceFilterStrength
} from '@/runtime/types';
import { VoiceFilterStrength } from '@/types';
import { createDesktopAppAudioPipeline } from './desktop-app-audio';
import micCaptureWorkletModuleUrl from './mic-capture.worklet.js?url&no-inline';

type TMicAudioProcessingBackend = 'sidecar-native';

type TMicAudioProcessingPipeline = {
  stream: MediaStream;
  track: MediaStreamTrack;
  backend: TMicAudioProcessingBackend;
  destroy: () => Promise<void>;
};

type TCreateMicAudioProcessingPipelineInput = {
  inputTrack: MediaStreamTrack;
  enabled: boolean;
  suppressionLevel: VoiceFilterStrength;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  echoCancellation: boolean;
};

const MIC_CAPTURE_WORKLET_NAME = 'sharkord-mic-capture-processor';
const FIRST_FILTERED_FRAME_TIMEOUT_MS = 4_000;

const getScriptProcessorBufferSize = (preferredFrameSize: number): number => {
  const clamped = Math.max(256, Math.min(16_384, Math.floor(preferredFrameSize)));
  let size = 256;

  while (size < clamped && size < 16_384) {
    size *= 2;
  }

  return size;
};

const ensureMicCaptureWorkletModule = async (audioContext: AudioContext) => {
  await audioContext.audioWorklet.addModule(micCaptureWorkletModuleUrl);
};

const createNativeDesktopMicAudioProcessingPipeline = async ({
  inputTrack,
  channels,
  suppressionLevel,
  noiseSuppression,
  autoGainControl,
  echoCancellation
}: {
  inputTrack: MediaStreamTrack;
  channels: number;
  suppressionLevel: VoiceFilterStrength;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  echoCancellation: boolean;
}): Promise<TMicAudioProcessingPipeline | undefined> => {
  const desktopBridge = getDesktopBridge();

  if (!desktopBridge) {
    return undefined;
  }

  const session = await desktopBridge.startVoiceFilterSession({
    sampleRate: 48_000,
    channels,
    suppressionLevel: suppressionLevel as unknown as TRuntimeVoiceFilterStrength,
    noiseSuppression,
    autoGainControl,
    echoCancellation
  });
  console.warn('[voice-filter-debug] Started native voice-filter session', {
    sessionId: session.sessionId,
    sampleRate: session.sampleRate,
    channels: session.channels,
    framesPerBuffer: session.framesPerBuffer,
    protocolVersion: session.protocolVersion
  });

  const outputPipeline = await createDesktopAppAudioPipeline({
    sessionId: session.sessionId,
    targetId: 'native-mic-filter',
    sampleRate: session.sampleRate,
    channels: session.channels,
    framesPerBuffer: session.framesPerBuffer,
    protocolVersion: session.protocolVersion,
    encoding: session.encoding
  }, {
    mode: 'stable',
    logLabel: 'mic-voice-filter',
    insertSilenceOnDroppedFrames: true
  });

  const AudioContextClass =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioContextClass) {
    await outputPipeline.destroy();
    await desktopBridge.stopVoiceFilterSession(session.sessionId);
    return undefined;
  }

  const captureContext = new AudioContextClass({
    sampleRate: session.sampleRate
  });
  const captureInputStream = new MediaStream([inputTrack]);
  const sourceNode = captureContext.createMediaStreamSource(captureInputStream);
  const targetFrameSize = Math.max(1, Math.floor(session.framesPerBuffer || 480));
  const scriptProcessorFrameSize = getScriptProcessorBufferSize(targetFrameSize);
  let workletNode: AudioWorkletNode | undefined;
  let processorNode: ScriptProcessorNode | undefined;
  const sinkNode = captureContext.createGain();
  sinkNode.gain.value = 0;
  let hasReceivedFilteredFrame = false;
  let settleFirstFilteredFrame: ((error?: Error) => void) | undefined;
  const firstFilteredFramePromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(
        new Error(`Native voice filter produced no frames (session=${session.sessionId})`)
      );
    }, FIRST_FILTERED_FRAME_TIMEOUT_MS);

    settleFirstFilteredFrame = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeout);

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };
  });

  let sequence = 0;
  let hasSentInputFrame = false;

  const removeFrameSubscription = desktopBridge.subscribeVoiceFilterFrames(
    (frame: TVoiceFilterFrame) => {
      if (frame.sessionId !== session.sessionId) {
        return;
      }

      outputPipeline.pushFrame({
        ...frame,
        targetId: 'native-mic-filter'
      });

      if (!hasReceivedFilteredFrame) {
        hasReceivedFilteredFrame = true;
        console.warn('[voice-filter-debug] Received first processed voice-filter frame', {
          sessionId: frame.sessionId,
          sequence: frame.sequence,
          frameCount: frame.frameCount,
          channels: frame.channels
        });
        settleFirstFilteredFrame?.();
      }
    }
  );

  const removeStatusSubscription = desktopBridge.subscribeVoiceFilterStatus(
    (statusEvent: TVoiceFilterStatusEvent) => {
      if (statusEvent.sessionId !== session.sessionId) {
        return;
      }

      if (statusEvent.reason !== 'capture_stopped') {
        console.warn('[voice-filter] Native voice filter session ended', statusEvent);
        if (statusEvent.error) {
          console.warn(
            '[voice-filter-debug] Native voice filter status error detail',
            statusEvent.error
          );
        }
      }

      if (!hasReceivedFilteredFrame) {
        settleFirstFilteredFrame?.(
          new Error(`Native voice filter ended before frames (${statusEvent.reason})`)
        );
      }
    }
  );

  const pushInterleavedPcmFrame = (samples: Float32Array, frameCount: number) => {
    if (frameCount <= 0) {
      return;
    }

    if (!hasSentInputFrame) {
      hasSentInputFrame = true;
      console.warn('[voice-filter-debug] Sending first PCM frame to sidecar', {
        sessionId: session.sessionId,
        sequence,
        frameCount,
        channels: session.channels,
        sampleRate: session.sampleRate
      });
    }

    desktopBridge.pushVoiceFilterPcmFrame({
      sessionId: session.sessionId,
      sequence,
      sampleRate: session.sampleRate,
      channels: session.channels,
      frameCount,
      pcm: samples,
      protocolVersion: 1
    });

    sequence += 1;
  };

  if (
    typeof AudioWorkletNode !== 'undefined' &&
    typeof captureContext.audioWorklet !== 'undefined'
  ) {
    try {
      await ensureMicCaptureWorkletModule(captureContext);

      workletNode = new AudioWorkletNode(captureContext, MIC_CAPTURE_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [session.channels],
        processorOptions: {
          channels: session.channels,
          targetFrameSize
        }
      });

      workletNode.port.onmessage = (messageEvent) => {
        const data = messageEvent.data;
        if (!data || data.type !== 'pcm' || !data.samples) {
          return;
        }

        const samples = data.samples as Float32Array;
        const frameCount =
          typeof data.frameCount === 'number'
            ? Math.floor(data.frameCount)
            : Math.floor(samples.length / session.channels);

        pushInterleavedPcmFrame(samples, frameCount);
      };
    } catch (error) {
      console.warn(
        '[voice-filter] AudioWorklet mic capture unavailable, using ScriptProcessor fallback',
        error
      );
      workletNode = undefined;
    }
  }

  if (workletNode) {
    sourceNode.connect(workletNode);
    workletNode.connect(sinkNode);
  } else {
    processorNode = captureContext.createScriptProcessor(
      scriptProcessorFrameSize,
      session.channels,
      session.channels
    );

    processorNode.onaudioprocess = (event) => {
      const inputBuffer = event.inputBuffer;
      const frameCount = inputBuffer.length;

      if (frameCount === 0) {
        return;
      }

      const interleaved = new Float32Array(frameCount * session.channels);

      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        for (let channelIndex = 0; channelIndex < session.channels; channelIndex += 1) {
          const sourceChannelIndex = Math.min(
            channelIndex,
            Math.max(0, inputBuffer.numberOfChannels - 1)
          );
          const sourceChannelData =
            inputBuffer.numberOfChannels > 0
              ? inputBuffer.getChannelData(sourceChannelIndex)
              : undefined;

          interleaved[frameIndex * session.channels + channelIndex] =
            sourceChannelData?.[frameIndex] ?? 0;
        }
      }

      pushInterleavedPcmFrame(interleaved, frameCount);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(sinkNode);
  }

  sinkNode.connect(captureContext.destination);

  void desktopBridge.ensureVoiceFilterFrameChannel();

  if (captureContext.state !== 'running') {
    await captureContext.resume();
  }

  try {
    outputPipeline.track.contentHint = 'speech';
  } catch {
    // ignore unsupported contentHint implementations
  }

  const pipeline: TMicAudioProcessingPipeline = {
    stream: outputPipeline.stream,
    track: outputPipeline.track,
    backend: 'sidecar-native',
    destroy: async () => {
      if (processorNode) {
        processorNode.onaudioprocess = null;
      }

      if (workletNode) {
        try {
          workletNode.port.onmessage = null;
          workletNode.port.postMessage({
            type: 'reset'
          });
        } catch {
          // ignore
        }
      }

      removeFrameSubscription();
      removeStatusSubscription();

      try {
        sourceNode.disconnect();
      } catch {
        // ignore
      }

      try {
        processorNode?.disconnect();
      } catch {
        // ignore
      }

      try {
        workletNode?.disconnect();
      } catch {
        // ignore
      }

      try {
        sinkNode.disconnect();
      } catch {
        // ignore
      }

      await desktopBridge.stopVoiceFilterSession(session.sessionId);
      await outputPipeline.destroy();
      await captureContext.close();
    }
  };

  try {
    await firstFilteredFramePromise;
  } catch (error) {
    await pipeline.destroy();
    throw error;
  }

  return pipeline;
};

const createMicAudioProcessingPipeline = async ({
  inputTrack,
  enabled,
  suppressionLevel,
  noiseSuppression,
  autoGainControl,
  echoCancellation
}: TCreateMicAudioProcessingPipelineInput): Promise<
  TMicAudioProcessingPipeline | undefined
> => {
  if (!enabled) {
    return undefined;
  }

  try {
    return await createNativeDesktopMicAudioProcessingPipeline({
      inputTrack,
      // Force mono for sidecar filter sessions to reduce runtime edge cases.
      channels: 1,
      suppressionLevel,
      noiseSuppression,
      autoGainControl,
      echoCancellation
    });
  } catch (error) {
    if (noiseSuppression) {
      try {
        const fallbackPipeline = await createNativeDesktopMicAudioProcessingPipeline({
          inputTrack,
          channels: 1,
          suppressionLevel,
          noiseSuppression: false,
          autoGainControl,
          echoCancellation
        });

        if (fallbackPipeline) {
          console.warn(
            '[voice-filter] Native filter fallback enabled without DeepFilter noise suppression'
          );
          return fallbackPipeline;
        }
      } catch (fallbackError) {
        console.warn(
          '[voice-filter] Native filter fallback (passthrough) failed, using raw mic',
          fallbackError
        );
      }
    }

    console.warn(
      '[voice-filter] Native desktop voice filter unavailable, using raw mic',
      error
    );
    return undefined;
  }
};

export { createMicAudioProcessingPipeline };
export type { TMicAudioProcessingBackend, TMicAudioProcessingPipeline };
