import { getDesktopBridge } from '@/runtime/desktop-bridge';
import type {
  TVoiceFilterFrame,
  TVoiceFilterStatusEvent,
  TVoiceFilterStrength as TRuntimeVoiceFilterStrength
} from '@/runtime/types';
import { VoiceFilterStrength } from '@/types';
import { createDesktopAppAudioPipeline } from './desktop-app-audio';

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

const getScriptProcessorBufferSize = (preferredFrameSize: number): number => {
  const clamped = Math.max(256, Math.min(16_384, Math.floor(preferredFrameSize)));
  let size = 256;

  while (size < clamped && size < 16_384) {
    size *= 2;
  }

  return size;
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
  const frameSize = getScriptProcessorBufferSize(session.framesPerBuffer || 480);
  const processorNode = captureContext.createScriptProcessor(
    frameSize,
    session.channels,
    session.channels
  );
  const sinkNode = captureContext.createGain();
  sinkNode.gain.value = 0;

  let sequence = 0;

  const removeFrameSubscription = desktopBridge.subscribeVoiceFilterFrames(
    (frame: TVoiceFilterFrame) => {
      if (frame.sessionId !== session.sessionId) {
        return;
      }

      outputPipeline.pushFrame({
        ...frame,
        targetId: 'native-mic-filter'
      });
    }
  );

  const removeStatusSubscription = desktopBridge.subscribeVoiceFilterStatus(
    (statusEvent: TVoiceFilterStatusEvent) => {
      if (statusEvent.sessionId !== session.sessionId) {
        return;
      }

      if (statusEvent.reason !== 'capture_stopped') {
        console.warn('[voice-filter] Native voice filter session ended', statusEvent);
      }
    }
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

    desktopBridge.pushVoiceFilterPcmFrame({
      sessionId: session.sessionId,
      sequence,
      sampleRate: session.sampleRate,
      channels: session.channels,
      frameCount,
      pcm: interleaved,
      protocolVersion: 1
    });

    sequence += 1;
  };

  sourceNode.connect(processorNode);
  processorNode.connect(sinkNode);
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

  return {
    stream: outputPipeline.stream,
    track: outputPipeline.track,
    backend: 'sidecar-native',
    destroy: async () => {
      processorNode.onaudioprocess = null;
      removeFrameSubscription();
      removeStatusSubscription();

      try {
        sourceNode.disconnect();
      } catch {
        // ignore
      }

      try {
        processorNode.disconnect();
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

  const inputSettings = inputTrack.getSettings();
  const outputChannels = Math.max(
    1,
    Math.min(
      2,
      typeof inputSettings.channelCount === 'number'
        ? inputSettings.channelCount
        : 1
    )
  );

  try {
    return await createNativeDesktopMicAudioProcessingPipeline({
      inputTrack,
      channels: outputChannels,
      suppressionLevel,
      noiseSuppression,
      autoGainControl,
      echoCancellation
    });
  } catch (error) {
    console.warn(
      '[voice-filter] Native desktop voice filter unavailable, using raw mic',
      error
    );
    return undefined;
  }
};

export { createMicAudioProcessingPipeline };
export type { TMicAudioProcessingBackend, TMicAudioProcessingPipeline };
