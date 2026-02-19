class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = Math.max(1, options.processorOptions?.channels || 1);
    this.targetFrameSize = Math.max(
      1,
      options.processorOptions?.targetFrameSize || 480
    );
    this.pendingChunks = [];
    this.pendingTotalFrames = 0;
    this.pendingFrameOffset = 0;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'reset') {
        this.pendingChunks = [];
        this.pendingTotalFrames = 0;
        this.pendingFrameOffset = 0;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    if (output && output.length > 0) {
      for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
        output[channelIndex].fill(0);
      }
    }

    const frameCount = input[0]?.length || 0;
    if (frameCount <= 0) {
      return true;
    }

    const interleaved = new Float32Array(frameCount * this.channels);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      for (let channelIndex = 0; channelIndex < this.channels; channelIndex += 1) {
        const sourceChannelIndex = Math.min(channelIndex, Math.max(0, input.length - 1));
        interleaved[frameIndex * this.channels + channelIndex] =
          input[sourceChannelIndex]?.[frameIndex] || 0;
      }
    }

    this.pendingChunks.push(interleaved);
    this.pendingTotalFrames += frameCount;

    while (this.pendingTotalFrames >= this.targetFrameSize) {
      const outputChunk = new Float32Array(this.targetFrameSize * this.channels);
      let writtenFrames = 0;

      while (writtenFrames < this.targetFrameSize && this.pendingChunks.length > 0) {
        const chunk = this.pendingChunks[0];
        const chunkFrames = chunk.length / this.channels;
        const availableFrames = chunkFrames - this.pendingFrameOffset;
        const framesToCopy = Math.min(this.targetFrameSize - writtenFrames, availableFrames);
        const sourceOffset = this.pendingFrameOffset * this.channels;
        const sourceEnd = sourceOffset + framesToCopy * this.channels;
        const destinationOffset = writtenFrames * this.channels;

        outputChunk.set(chunk.subarray(sourceOffset, sourceEnd), destinationOffset);

        writtenFrames += framesToCopy;
        this.pendingFrameOffset += framesToCopy;

        if (this.pendingFrameOffset >= chunkFrames) {
          this.pendingChunks.shift();
          this.pendingFrameOffset = 0;
        }
      }

      this.pendingTotalFrames -= this.targetFrameSize;
      this.port.postMessage(
        {
          type: 'pcm',
          frameCount: this.targetFrameSize,
          samples: outputChunk,
        },
        [outputChunk.buffer]
      );
    }

    return true;
  }
}

registerProcessor('sharkord-mic-capture-processor', MicCaptureProcessor);
