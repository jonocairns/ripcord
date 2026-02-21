type TMicReferenceAudioPipeline = {
  updateStreams: (streams: MediaStream[]) => void;
  destroy: () => Promise<void>;
};

type TCreateMicReferenceAudioPipelineInput = {
  sampleRate: number;
  channels: number;
  targetFrameSize: number;
  onFrame: (samples: Float32Array, frameCount: number) => void;
};

const getScriptProcessorBufferSize = (preferredFrameSize: number): number => {
  const clamped = Math.max(256, Math.min(16_384, Math.floor(preferredFrameSize)));
  let size = 256;

  while (size < clamped && size < 16_384) {
    size *= 2;
  }

  return size;
};

const createMicReferenceAudioPipeline = async ({
  sampleRate,
  channels,
  targetFrameSize,
  onFrame
}: TCreateMicReferenceAudioPipelineInput): Promise<
  TMicReferenceAudioPipeline | undefined
> => {
  const AudioContextClass =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioContextClass) {
    return undefined;
  }

  const outputChannels = Math.max(1, Math.min(2, Math.floor(channels || 1)));
  const normalizedTargetFrameSize = Math.max(1, Math.floor(targetFrameSize || 480));
  const audioContext = new AudioContextClass({
    sampleRate
  });
  const mixNode = audioContext.createGain();
  mixNode.gain.value = 1;
  const scriptProcessorFrameSize = getScriptProcessorBufferSize(
    normalizedTargetFrameSize
  );
  const processorNode = audioContext.createScriptProcessor(
    scriptProcessorFrameSize,
    outputChannels,
    outputChannels
  );
  const sinkNode = audioContext.createGain();
  sinkNode.gain.value = 0;
  const pendingChunks: Float32Array[] = [];
  let pendingTotalFrames = 0;
  let pendingFrameOffset = 0;
  let sourceNodes: MediaStreamAudioSourceNode[] = [];

  processorNode.onaudioprocess = (event) => {
    const inputBuffer = event.inputBuffer;
    const outputBuffer = event.outputBuffer;
    const frameCount = inputBuffer.length;

    for (let channelIndex = 0; channelIndex < outputBuffer.numberOfChannels; channelIndex += 1) {
      outputBuffer.getChannelData(channelIndex).fill(0);
    }

    if (frameCount <= 0) {
      return;
    }

    const interleaved = new Float32Array(frameCount * outputChannels);

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      for (let channelIndex = 0; channelIndex < outputChannels; channelIndex += 1) {
        const sourceChannelIndex = Math.min(
          channelIndex,
          Math.max(0, inputBuffer.numberOfChannels - 1)
        );
        const sourceChannelData =
          inputBuffer.numberOfChannels > 0
            ? inputBuffer.getChannelData(sourceChannelIndex)
            : undefined;
        interleaved[frameIndex * outputChannels + channelIndex] =
          sourceChannelData?.[frameIndex] ?? 0;
      }
    }

    pendingChunks.push(interleaved);
    pendingTotalFrames += frameCount;

    while (pendingTotalFrames >= normalizedTargetFrameSize) {
      const frameSamples = new Float32Array(
        normalizedTargetFrameSize * outputChannels
      );
      let writtenFrames = 0;

      while (
        writtenFrames < normalizedTargetFrameSize &&
        pendingChunks.length > 0
      ) {
        const chunk = pendingChunks[0]!;
        const chunkFrames = chunk.length / outputChannels;
        const availableFrames = chunkFrames - pendingFrameOffset;
        const framesToCopy = Math.min(
          normalizedTargetFrameSize - writtenFrames,
          availableFrames
        );
        const sourceOffset = pendingFrameOffset * outputChannels;
        const sourceEnd = sourceOffset + framesToCopy * outputChannels;
        const destinationOffset = writtenFrames * outputChannels;

        frameSamples.set(chunk.subarray(sourceOffset, sourceEnd), destinationOffset);

        writtenFrames += framesToCopy;
        pendingFrameOffset += framesToCopy;

        if (pendingFrameOffset >= chunkFrames) {
          pendingChunks.shift();
          pendingFrameOffset = 0;
        }
      }

      pendingTotalFrames -= normalizedTargetFrameSize;
      onFrame(frameSamples, normalizedTargetFrameSize);
    }
  };

  mixNode.connect(processorNode);
  processorNode.connect(sinkNode);
  sinkNode.connect(audioContext.destination);

  if (audioContext.state !== 'running') {
    await audioContext.resume();
  }

  const updateStreams = (streams: MediaStream[]) => {
    sourceNodes.forEach((sourceNode) => {
      try {
        sourceNode.disconnect();
      } catch {
        // ignore
      }
    });
    sourceNodes = [];

    streams.forEach((stream) => {
      const liveAudioTracks = stream
        .getAudioTracks()
        .filter((track) => track.readyState === 'live');

      if (liveAudioTracks.length === 0) {
        return;
      }

      try {
        const sourceStream = new MediaStream(liveAudioTracks);
        const sourceNode = audioContext.createMediaStreamSource(sourceStream);
        sourceNode.connect(mixNode);
        sourceNodes.push(sourceNode);
      } catch {
        // ignore
      }
    });
  };

  return {
    updateStreams,
    destroy: async () => {
      processorNode.onaudioprocess = null;

      sourceNodes.forEach((sourceNode) => {
        try {
          sourceNode.disconnect();
        } catch {
          // ignore
        }
      });
      sourceNodes = [];

      try {
        mixNode.disconnect();
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

      await audioContext.close();
    }
  };
};

export { createMicReferenceAudioPipeline };
export type { TMicReferenceAudioPipeline };
