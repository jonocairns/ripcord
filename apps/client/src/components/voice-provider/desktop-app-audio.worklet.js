class PcmQueueProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = Math.max(1, options.processorOptions?.channels || 2);
    this.targetChunks = Math.max(
      1,
      options.processorOptions?.targetChunks || 4
    );
    this.trimStartChunks = Math.max(
      this.targetChunks + 1,
      options.processorOptions?.trimStartChunks || this.targetChunks * 2
    );
    this.maxChunks = Math.max(1, options.processorOptions?.maxChunks || 8);
    this.trimQueueForLowLatency =
      options.processorOptions?.trimQueueForLowLatency !== false;
    this.emitQueueTelemetry = options.processorOptions?.emitQueueTelemetry === true;
    this.telemetryIntervalSeconds = Math.max(
      0.25,
      (options.processorOptions?.queueTelemetryIntervalMs || 1000) / 1000
    );
    this.lastTelemetryAt = -Infinity;
    this.queue = [];
    this.currentChunk = null;
    this.chunkFrameOffset = 0;
    this.overflownChunks = 0;
    this.trimmedChunks = 0;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'pcm' && data.samples) {
        while (this.queue.length >= this.maxChunks) {
          this.queue.shift();
          this.overflownChunks += 1;
        }

        if (this.trimQueueForLowLatency && this.queue.length >= this.trimStartChunks) {
          while (this.queue.length >= this.targetChunks) {
            this.queue.shift();
            this.trimmedChunks += 1;
          }
        }

        if (this.trimmedChunks > 0 && this.trimmedChunks % 10 === 0) {
          this.port.postMessage({
            type: 'queue-trim',
            trimmedChunks: this.trimmedChunks,
          });
        }

        this.queue.push(data.samples);

        if (this.overflownChunks > 0 && this.overflownChunks % 10 === 0) {
          this.port.postMessage({
            type: 'queue-overflow',
            droppedChunks: this.overflownChunks,
          });
        }
        return;
      }

      if (data.type === 'reset') {
        this.queue = [];
        this.currentChunk = null;
        this.chunkFrameOffset = 0;
        this.overflownChunks = 0;
        this.trimmedChunks = 0;
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

    if (
      this.emitQueueTelemetry &&
      currentTime - this.lastTelemetryAt >= this.telemetryIntervalSeconds
    ) {
      let queuedFrames = 0;
      for (let index = 0; index < this.queue.length; index += 1) {
        queuedFrames += this.queue[index].length / this.channels;
      }

      if (this.currentChunk) {
        queuedFrames +=
          this.currentChunk.length / this.channels - this.chunkFrameOffset;
      }

      this.port.postMessage({
        type: 'queue-stats',
        queueDepthChunks: this.queue.length + (this.currentChunk ? 1 : 0),
        queuedFrames,
        targetChunks: this.targetChunks,
        trimStartChunks: this.trimStartChunks,
        maxChunks: this.maxChunks,
        trimmedChunks: this.trimmedChunks,
        droppedChunks: this.overflownChunks
      });
      this.lastTelemetryAt = currentTime;
    }

    return true;
  }
}

registerProcessor('sharkord-pcm-queue-processor', PcmQueueProcessor);
