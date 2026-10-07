const WORKLET_NAME = 'sharkord-voice-filter-wasm-processor';
const TELEMETRY_QUANTUM_INTERVAL = 32;

const getSharedRingAvailableFrames = (state) => {
	return Atomics.load(state, 2);
};

const writeSharedRing = (samples, data, state) => {
	const capacity = data.length;
	const available = getSharedRingAvailableFrames(state);
	const freeFrames = Math.max(0, capacity - available);
	const framesToWrite = Math.min(samples.length, freeFrames);
	let writeIndex = Atomics.load(state, 1);

	for (let sampleIndex = 0; sampleIndex < framesToWrite; sampleIndex += 1) {
		data[writeIndex] = samples[sampleIndex];
		writeIndex = (writeIndex + 1) % capacity;
	}

	Atomics.store(state, 1, writeIndex);
	Atomics.add(state, 2, framesToWrite);

	return framesToWrite;
};

const readSharedRing = (target, data, state) => {
	const available = getSharedRingAvailableFrames(state);
	const framesToRead = Math.min(target.length, available);
	let readIndex = Atomics.load(state, 0);

	for (let sampleIndex = 0; sampleIndex < framesToRead; sampleIndex += 1) {
		target[sampleIndex] = data[readIndex];
		readIndex = (readIndex + 1) % data.length;
	}

	Atomics.store(state, 0, readIndex);
	Atomics.sub(state, 2, framesToRead);

	return framesToRead;
};

class VoiceFilterWasmProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();

		this.transportMode = options.processorOptions?.transportMode || 'message-port';
		this.controlPort = undefined;
		this.outputChunks = [];
		this.outputChunkOffset = 0;
		this.outputUnderruns = 0;
		this.inputDrops = 0;
		this.telemetryQuantumCounter = 0;

		if (this.transportMode === 'shared-array-buffer') {
			this.inputData = new Float32Array(options.processorOptions.inputDataBuffer);
			this.inputState = new Int32Array(options.processorOptions.inputStateBuffer);
			this.outputData = new Float32Array(options.processorOptions.outputDataBuffer);
			this.outputState = new Int32Array(options.processorOptions.outputStateBuffer);
		}

		this.port.onmessage = (event) => {
			const data = event.data || {};

			if (data.type === 'attach-control-port' && data.port) {
				this.controlPort = data.port;
				this.controlPort.onmessage = (portEvent) => {
					const portData = portEvent.data || {};

					if (portData.type === 'output' && portData.samples instanceof Float32Array) {
						this.outputChunks.push(portData.samples);
					}
				};
				this.controlPort.start?.();
				return;
			}

			if (data.type === 'reset') {
				this.outputChunks = [];
				this.outputChunkOffset = 0;
				this.outputUnderruns = 0;
				this.inputDrops = 0;
			}
		};
	}

	mixInputToMono(inputChannels, frameCount) {
		const mono = new Float32Array(frameCount);

		if (!inputChannels || inputChannels.length === 0) {
			return mono;
		}

		const channelCount = inputChannels.length;

		for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
			let sample = 0;

			for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
				sample += inputChannels[channelIndex]?.[frameIndex] || 0;
			}

			mono[frameIndex] = sample / channelCount;
		}

		return mono;
	}

	readQueuedOutput(target) {
		let writtenFrames = 0;

		while (writtenFrames < target.length && this.outputChunks.length > 0) {
			const chunk = this.outputChunks[0];
			const availableFrames = chunk.length - this.outputChunkOffset;
			const framesToCopy = Math.min(target.length - writtenFrames, availableFrames);

			target.set(chunk.subarray(this.outputChunkOffset, this.outputChunkOffset + framesToCopy), writtenFrames);
			writtenFrames += framesToCopy;
			this.outputChunkOffset += framesToCopy;

			if (this.outputChunkOffset >= chunk.length) {
				this.outputChunks.shift();
				this.outputChunkOffset = 0;
			}
		}

		return writtenFrames;
	}

	getOutputQueueFrames() {
		if (this.transportMode === 'shared-array-buffer') {
			return getSharedRingAvailableFrames(this.outputState);
		}

		if (this.outputChunks.length === 0) {
			return 0;
		}

		let queuedFrames = this.outputChunks[0].length - this.outputChunkOffset;

		for (let chunkIndex = 1; chunkIndex < this.outputChunks.length; chunkIndex += 1) {
			queuedFrames += this.outputChunks[chunkIndex].length;
		}

		return queuedFrames;
	}

	emitTelemetry(force = false) {
		if (!this.controlPort) {
			return;
		}

		if (!force && this.telemetryQuantumCounter < TELEMETRY_QUANTUM_INTERVAL) {
			return;
		}

		this.telemetryQuantumCounter = 0;
		this.controlPort.postMessage({
			type: 'telemetry',
			transportMode: this.transportMode,
			inputDrops: this.inputDrops,
			outputUnderruns: this.outputUnderruns,
			outputQueueFrames: this.getOutputQueueFrames(),
		});
	}

	process(inputs, outputs) {
		const inputChannels = inputs[0] || [];
		const outputChannels = outputs[0] || [];
		const frameCount = outputChannels[0]?.length || inputChannels[0]?.length || 128;

		if (outputChannels.length === 0 || frameCount <= 0) {
			return true;
		}

		const monoInput = this.mixInputToMono(inputChannels, frameCount);

		if (this.transportMode === 'shared-array-buffer') {
			const writtenFrames = writeSharedRing(monoInput, this.inputData, this.inputState);
			this.inputDrops += monoInput.length - writtenFrames;
		} else if (this.controlPort) {
			this.controlPort.postMessage({
				type: 'input',
				samples: monoInput,
			});
		}

		const monoOutput = outputChannels[0];
		let writtenFrames = 0;

		if (this.transportMode === 'shared-array-buffer') {
			writtenFrames = readSharedRing(monoOutput, this.outputData, this.outputState);
		} else {
			writtenFrames = this.readQueuedOutput(monoOutput);
		}

		if (writtenFrames < frameCount) {
			this.outputUnderruns += 1;

			for (let frameIndex = writtenFrames; frameIndex < frameCount; frameIndex += 1) {
				monoOutput[frameIndex] = monoInput[frameIndex] || 0;
			}
		}

		for (let channelIndex = 1; channelIndex < outputChannels.length; channelIndex += 1) {
			outputChannels[channelIndex].set(monoOutput);
		}

		this.telemetryQuantumCounter += 1;
		this.emitTelemetry();

		return true;
	}
}

registerProcessor(WORKLET_NAME, VoiceFilterWasmProcessor);
