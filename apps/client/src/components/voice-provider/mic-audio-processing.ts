import { createWasmMicAudioProcessingPipeline } from './wasm-mic-audio-processing';

type TMicAudioProcessingBackend = 'browser-wasm';

type TMicAudioProcessingPipeline = {
	sessionId: string;
	sampleRate: number;
	channels: number;
	framesPerBuffer: number;
	stream: MediaStream;
	track: MediaStreamTrack;
	backend: TMicAudioProcessingBackend;
	destroy: () => Promise<void>;
};

type TCreateMicAudioProcessingPipelineInput = {
	inputTrack: MediaStreamTrack;
	wasmNoiseSuppressionEnabled: boolean;
	onWasmError?: (error: Error) => void;
};

const createMicAudioProcessingPipeline = async ({
	inputTrack,
	wasmNoiseSuppressionEnabled,
	onWasmError,
}: TCreateMicAudioProcessingPipelineInput): Promise<TMicAudioProcessingPipeline | undefined> => {
	if (!wasmNoiseSuppressionEnabled) {
		return undefined;
	}

	try {
		return await createWasmMicAudioProcessingPipeline({
			inputTrack,
			onError: onWasmError,
		});
	} catch (error) {
		console.warn('[voice-filter] Browser WASM voice filter unavailable, using raw mic', error);
		return undefined;
	}
};

export type { TMicAudioProcessingBackend, TMicAudioProcessingPipeline };
export { createMicAudioProcessingPipeline };
