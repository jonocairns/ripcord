import voiceFilterWasmWorkletModuleUrl from './voice-filter-wasm.worklet.js?url&no-inline';
import VoiceFilterWasmWorker from './voice-filter-wasm.worker.ts?worker';

const WORKLET_NAME = 'sharkord-voice-filter-wasm-processor';
const DTLN_BLOCK_SIZE_48_KHZ = 1_536;
const DIAGNOSTICS_LOG_INTERVAL_MS = 5_000;
const SHARED_RING_CAPACITY_FRAMES = 24_576;
const DTLN_MODULE_PATH = 'voice-filter/dtln-emscripten.mjs';
const DTLN_WASM_PATH = 'voice-filter/dtln_rs.wasm';

type TWasmTransportMode = 'shared-array-buffer' | 'message-port';

type TCreateWasmMicAudioProcessingPipelineInput = {
	inputTrack: MediaStreamTrack;
	onError?: (error: Error) => void;
};

type TWasmMicAudioProcessingPipeline = {
	sessionId: string;
	sampleRate: number;
	channels: number;
	framesPerBuffer: number;
	stream: MediaStream;
	track: MediaStreamTrack;
	backend: 'browser-wasm';
	destroy: () => Promise<void>;
};

type TWorkerStats = {
	sessionId: string;
	transportMode: TWasmTransportMode;
	processedBlocks: number;
	averageProcessTimeMs: number | null;
	maxProcessTimeMs: number | null;
	inputQueueFrames: number;
	outputQueueFrames: number;
	inputDrops: number;
	outputDrops: number;
	outputUnderruns: number;
};

type TWorkerReadyMessage = {
	type: 'ready';
	sessionId: string;
	transportMode: TWasmTransportMode;
	framesPerBlock48Khz: number;
};

type TWorkerStatsMessage = {
	type: 'stats';
	stats: TWorkerStats;
};

type TWorkerErrorMessage = {
	type: 'error';
	error: string;
};

type TWorkerMessage = TWorkerReadyMessage | TWorkerStatsMessage | TWorkerErrorMessage;

type TWasmDenoiseDiagSnapshot = {
	sessionId: string;
	transportMode: TWasmTransportMode;
	processedBlocks: number;
	averageProcessTimeMs: number | null;
	maxProcessTimeMs: number | null;
	inputQueueFrames: number;
	outputQueueFrames: number;
	inputDrops: number;
	outputDrops: number;
	outputUnderruns: number;
	timestampMs: number;
};

declare global {
	interface Window {
		wasmDenoiseDiag: TWasmDenoiseDiagSnapshot | null;
		webkitAudioContext?: typeof AudioContext;
	}
}

if (typeof window !== 'undefined') {
	window.wasmDenoiseDiag = null;
}

const nowSteadyEpochMs = (): number => {
	if (typeof performance === 'undefined') {
		return Date.now();
	}

	const now = typeof performance.now === 'function' ? performance.now() : undefined;
	if (typeof now !== 'number' || !Number.isFinite(now)) {
		return Date.now();
	}

	const timeOrigin =
		typeof performance.timeOrigin === 'number' && Number.isFinite(performance.timeOrigin)
			? performance.timeOrigin
			: Date.now() - now;

	return timeOrigin + now;
};

const createSessionId = (): string => {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}

	return `browser-wasm-${Date.now()}`;
};

const createSharedRingBuffers = () => {
	return {
		inputDataBuffer: new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * SHARED_RING_CAPACITY_FRAMES),
		inputStateBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4),
		outputDataBuffer: new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * SHARED_RING_CAPACITY_FRAMES),
		outputStateBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4),
	};
};

const supportsSharedArrayBufferTransport = () => {
	if (typeof window === 'undefined') {
		return false;
	}

	return (
		window.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined'
	);
};

const resolveVoiceFilterAssetUrl = (assetPath: string): string => {
	const normalizedAssetPath = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;

	if (typeof window === 'undefined') {
		return `/${normalizedAssetPath}`;
	}

	const baseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
	return new URL(normalizedAssetPath, baseUrl).toString();
};

const createDiagnosticsTracker = (sessionId: string) => {
	let lastLoggedAt = 0;

	return {
		update(stats: TWorkerStats) {
			const snapshot: TWasmDenoiseDiagSnapshot = {
				sessionId,
				transportMode: stats.transportMode,
				processedBlocks: stats.processedBlocks,
				averageProcessTimeMs: stats.averageProcessTimeMs,
				maxProcessTimeMs: stats.maxProcessTimeMs,
				inputQueueFrames: stats.inputQueueFrames,
				outputQueueFrames: stats.outputQueueFrames,
				inputDrops: stats.inputDrops,
				outputDrops: stats.outputDrops,
				outputUnderruns: stats.outputUnderruns,
				timestampMs: nowSteadyEpochMs(),
			};

			if (typeof window !== 'undefined') {
				window.wasmDenoiseDiag = snapshot;
			}

			if (Date.now() - lastLoggedAt >= DIAGNOSTICS_LOG_INTERVAL_MS) {
				lastLoggedAt = Date.now();
				console.log('[wasm-denoise-diag]', snapshot);
			}
		},
		reset() {
			if (typeof window !== 'undefined') {
				window.wasmDenoiseDiag = null;
			}
		},
	};
};

const createWasmMicAudioProcessingPipeline = async ({
	inputTrack,
	onError,
}: TCreateWasmMicAudioProcessingPipelineInput): Promise<TWasmMicAudioProcessingPipeline> => {
	const AudioContextClass = window.AudioContext || window.webkitAudioContext;

	if (!AudioContextClass) {
		throw new Error('AudioContext is unavailable for browser WASM voice filtering');
	}

	if (typeof AudioWorkletNode === 'undefined') {
		throw new Error('AudioWorklet is unavailable for browser WASM voice filtering');
	}

	const sessionId = createSessionId();
	const diagnostics = createDiagnosticsTracker(sessionId);
	const transportMode: TWasmTransportMode = supportsSharedArrayBufferTransport()
		? 'shared-array-buffer'
		: 'message-port';
	const audioContext = new AudioContextClass({
		sampleRate: 48_000,
		latencyHint: 'interactive',
	});
	const sourceStream = new MediaStream([inputTrack]);
	const sourceNode = audioContext.createMediaStreamSource(sourceStream);
	const destinationNode = audioContext.createMediaStreamDestination();
	const worker = new VoiceFilterWasmWorker();
	const controlChannel = new MessageChannel();
	const sharedRingBuffers = transportMode === 'shared-array-buffer' ? createSharedRingBuffers() : undefined;
	const moduleUrl = resolveVoiceFilterAssetUrl(DTLN_MODULE_PATH);
	const wasmUrl = resolveVoiceFilterAssetUrl(DTLN_WASM_PATH);

	let workletNode: AudioWorkletNode | undefined;

	const workerReadyPromise = new Promise<TWorkerReadyMessage>((resolve, reject) => {
		worker.onmessage = (event: MessageEvent<TWorkerMessage>) => {
			const message = event.data;

			if (message.type === 'ready') {
				resolve(message);
				return;
			}

			if (message.type === 'stats') {
				diagnostics.update(message.stats);
				return;
			}

			reject(new Error(message.error));
		};

		worker.onerror = (event) => {
			reject(new Error(event.message || 'Browser WASM voice filter worker crashed'));
		};
	});

	try {
		await audioContext.audioWorklet.addModule(voiceFilterWasmWorkletModuleUrl);

		workletNode = new AudioWorkletNode(audioContext, WORKLET_NAME, {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [1],
			processorOptions: {
				transportMode,
				...(sharedRingBuffers ?? {}),
			},
		});

		workletNode.port.postMessage(
			{
				type: 'attach-control-port',
				port: controlChannel.port2,
			},
			[controlChannel.port2],
		);

		worker.postMessage(
			{
				type: 'init',
				sessionId,
				transportMode,
				moduleUrl,
				wasmUrl,
				controlPort: controlChannel.port1,
				...(sharedRingBuffers ?? {}),
			},
			[controlChannel.port1],
		);

		sourceNode.connect(workletNode);
		workletNode.connect(destinationNode);

		if (audioContext.state !== 'running') {
			await audioContext.resume();
		}

		const readyMessage = await workerReadyPromise;

		if (readyMessage.framesPerBlock48Khz !== DTLN_BLOCK_SIZE_48_KHZ) {
			throw new Error('Unexpected browser WASM voice filter block size');
		}

		// Replace init-phase handlers with post-ready handlers so runtime
		// errors are surfaced instead of silently swallowed by the settled promise.
		worker.onmessage = (event: MessageEvent<TWorkerMessage>) => {
			const message = event.data;

			if (message.type === 'stats') {
				diagnostics.update(message.stats);
				return;
			}

			if (message.type === 'error') {
				const error = new Error(message.error);
				console.error('[wasm-denoise] Worker runtime error:', error);
				onError?.(error);
			}
		};

		worker.onerror = (event) => {
			const error = new Error(event.message || 'Browser WASM voice filter worker crashed');
			console.error('[wasm-denoise] Worker crashed:', error);
			onError?.(error);
		};

		workletNode.onprocessorerror = () => {
			const error = new Error('Browser WASM voice filter worklet processor crashed');
			console.error('[wasm-denoise] Worklet processor error:', error);
			onError?.(error);
		};

		const track = destinationNode.stream.getAudioTracks()[0];

		if (!track) {
			throw new Error('Failed to create MediaStreamTrack from browser WASM voice filter output');
		}

		return {
			sessionId,
			sampleRate: 48_000,
			channels: 1,
			framesPerBuffer: DTLN_BLOCK_SIZE_48_KHZ,
			stream: destinationNode.stream,
			track,
			backend: 'browser-wasm',
			destroy: async () => {
				diagnostics.reset();

				try {
					workletNode?.port.postMessage({
						type: 'reset',
					});
				} catch {
					// ignore
				}

				try {
					sourceNode.disconnect();
				} catch {
					// ignore
				}

				try {
					workletNode?.disconnect();
				} catch {
					// ignore
				}

				try {
					destinationNode.disconnect();
				} catch {
					// ignore
				}

				worker.terminate();
				await audioContext.close();
			},
		};
	} catch (error) {
		diagnostics.reset();

		try {
			sourceNode.disconnect();
		} catch {
			// ignore
		}

		try {
			workletNode?.disconnect();
		} catch {
			// ignore
		}

		try {
			destinationNode.disconnect();
		} catch {
			// ignore
		}

		worker.terminate();
		await audioContext.close();

		throw error;
	}
};

export type { TWasmMicAudioProcessingPipeline };
export { createWasmMicAudioProcessingPipeline };
