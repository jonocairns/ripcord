import micCaptureWorkletModuleUrl from './mic-capture.worklet.js?url&no-inline';

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

const MIC_REFERENCE_CAPTURE_WORKLET_NAME = 'sharkord-mic-capture-processor';

const ensureMicReferenceCaptureWorkletModule = async (audioContext: AudioContext) => {
	await audioContext.audioWorklet.addModule(micCaptureWorkletModuleUrl);
};

const createMicReferenceAudioPipeline = async ({
	sampleRate,
	channels,
	targetFrameSize,
	onFrame,
}: TCreateMicReferenceAudioPipelineInput): Promise<TMicReferenceAudioPipeline | undefined> => {
	const AudioContextClass =
		window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

	if (!AudioContextClass) {
		return undefined;
	}

	const outputChannels = Math.max(1, Math.min(2, Math.floor(channels || 1)));
	const normalizedTargetFrameSize = Math.max(1, Math.floor(targetFrameSize || 480));
	const audioContext = new AudioContextClass({
		sampleRate,
	});
	const mixNode = audioContext.createGain();
	mixNode.gain.value = 1;
	let workletNode: AudioWorkletNode;
	const sinkNode = audioContext.createGain();
	sinkNode.gain.value = 0;
	const pendingChunks: Float32Array[] = [];
	let pendingTotalFrames = 0;
	let pendingFrameOffset = 0;
	let sourceNodes: MediaStreamAudioSourceNode[] = [];

	const appendInterleavedChunk = (chunk: Float32Array, frameCount: number) => {
		if (frameCount <= 0) {
			return;
		}

		pendingChunks.push(chunk);
		pendingTotalFrames += frameCount;

		while (pendingTotalFrames >= normalizedTargetFrameSize) {
			const frameSamples = new Float32Array(normalizedTargetFrameSize * outputChannels);
			let writtenFrames = 0;

			while (writtenFrames < normalizedTargetFrameSize && pendingChunks.length > 0) {
				const chunk = pendingChunks[0]!;
				const chunkFrames = chunk.length / outputChannels;
				const availableFrames = chunkFrames - pendingFrameOffset;
				const framesToCopy = Math.min(normalizedTargetFrameSize - writtenFrames, availableFrames);
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

	if (typeof AudioWorkletNode === 'undefined' || typeof audioContext.audioWorklet === 'undefined') {
		await audioContext.close();
		return undefined;
	}

	try {
		await ensureMicReferenceCaptureWorkletModule(audioContext);

		workletNode = new AudioWorkletNode(audioContext, MIC_REFERENCE_CAPTURE_WORKLET_NAME, {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [outputChannels],
			processorOptions: {
				channels: outputChannels,
				targetFrameSize: normalizedTargetFrameSize,
			},
		});
	} catch (error) {
		console.warn('[voice-filter] AudioWorklet mic reference capture unavailable', error);
		await audioContext.close();
		return undefined;
	}

	workletNode.port.onmessage = (messageEvent) => {
		const data = messageEvent.data;
		if (!data || data.type !== 'pcm' || !data.samples) {
			return;
		}

		const samples = data.samples as Float32Array;
		const frameCount =
			typeof data.frameCount === 'number' ? Math.floor(data.frameCount) : Math.floor(samples.length / outputChannels);

		appendInterleavedChunk(samples, frameCount);
	};

	mixNode.connect(workletNode);
	workletNode.connect(sinkNode);

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
			const liveAudioTracks = stream.getAudioTracks().filter((track) => track.readyState === 'live');

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
			try {
				workletNode.port.onmessage = null;
				workletNode.port.postMessage({
					type: 'reset',
				});
			} catch {
				// ignore
			}

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
				workletNode.disconnect();
			} catch {
				// ignore
			}

			try {
				sinkNode.disconnect();
			} catch {
				// ignore
			}

			await audioContext.close();
		},
	};
};

export type { TMicReferenceAudioPipeline };
export { createMicReferenceAudioPipeline };
