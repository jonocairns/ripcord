import type { TAppAudioFrame, TAppAudioSession } from '@/runtime/types';

type TDesktopAppAudioPipeline = {
  sessionId: string;
  stream: MediaStream;
  track: MediaStreamTrack;
  pushFrame: (frame: TAppAudioFrame) => void;
  destroy: () => Promise<void>;
};

const WORKLET_NAME = 'sharkord-pcm-queue-processor';
const WORKLET_MAX_CHUNKS = 50;
let workletModuleUrl: string | undefined;

const WORKLET_SOURCE = `
class PcmQueueProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = Math.max(1, options.processorOptions?.channels || 2);
    this.maxChunks = Math.max(1, options.processorOptions?.maxChunks || 50);
    this.queue = [];
    this.currentChunk = null;
    this.chunkFrameOffset = 0;
    this.overflownChunks = 0;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'pcm' && data.samples) {
        if (this.queue.length >= this.maxChunks) {
          this.queue.shift();
          this.overflownChunks += 1;
        }

        this.queue.push(data.samples);

        if (this.overflownChunks > 0 && this.overflownChunks % 10 === 0) {
          this.port.postMessage({
            type: 'queue-overflow',
            droppedChunks: this.overflownChunks
          });
        }
        return;
      }

      if (data.type === 'reset') {
        this.queue = [];
        this.currentChunk = null;
        this.chunkFrameOffset = 0;
        this.overflownChunks = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }

    const frameCount = output[0].length;

    for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
      output[channelIndex].fill(0);
    }

    let writtenFrames = 0;

    while (writtenFrames < frameCount) {
      if (!this.currentChunk) {
        this.currentChunk = this.queue.shift() || null;
        this.chunkFrameOffset = 0;

        if (!this.currentChunk) {
          break;
        }
      }

      const availableFrames =
        this.currentChunk.length / this.channels - this.chunkFrameOffset;
      const framesToCopy = Math.min(frameCount - writtenFrames, availableFrames);

      for (let frameOffset = 0; frameOffset < framesToCopy; frameOffset += 1) {
        const sourceFrameIndex = this.chunkFrameOffset + frameOffset;
        const sourceBaseOffset = sourceFrameIndex * this.channels;
        const outputFrameIndex = writtenFrames + frameOffset;

        for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
          const sourceChannelIndex = Math.min(channelIndex, this.channels - 1);
          output[channelIndex][outputFrameIndex] =
            this.currentChunk[sourceBaseOffset + sourceChannelIndex] || 0;
        }
      }

      writtenFrames += framesToCopy;
      this.chunkFrameOffset += framesToCopy;

      if (this.chunkFrameOffset >= this.currentChunk.length / this.channels) {
        this.currentChunk = null;
        this.chunkFrameOffset = 0;
      }
    }

    return true;
  }
}

registerProcessor('${WORKLET_NAME}', PcmQueueProcessor);
`;

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
  if (!workletModuleUrl) {
    const blob = new Blob([WORKLET_SOURCE], {
      type: 'application/javascript'
    });
    workletModuleUrl = URL.createObjectURL(blob);
  }

  await audioContext.audioWorklet.addModule(workletModuleUrl);
};

const createDesktopAppAudioPipeline = async (
  session: TAppAudioSession
): Promise<TDesktopAppAudioPipeline> => {
  const audioContext = new AudioContext({
    sampleRate: session.sampleRate
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
      maxChunks: WORKLET_MAX_CHUNKS
    }
  });

  workletNode.connect(destinationNode);

  workletNode.port.onmessage = (event) => {
    const data = event.data;

    if (data?.type === 'queue-overflow') {
      console.warn('[desktop-app-audio] PCM queue overflow', data);
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
          '[desktop-app-audio] Unsupported app audio protocol version',
          frame.protocolVersion
        );
        return;
      }

      if (frame.encoding !== 'f32le_base64') {
        console.warn(
          '[desktop-app-audio] Unsupported app audio frame encoding',
          frame.encoding
        );
        return;
      }

      if (frame.droppedFrameCount && frame.droppedFrameCount > 0) {
        console.warn('[desktop-app-audio] Sidecar dropped frames', {
          droppedFrameCount: frame.droppedFrameCount
        });
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
export type { TDesktopAppAudioPipeline };
