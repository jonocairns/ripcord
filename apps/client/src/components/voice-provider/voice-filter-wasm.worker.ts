/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope;

const DTLN_BLOCK_SIZE_16_KHZ = 512;
const SAB_POLL_INTERVAL_MS = 4;
const STATS_INTERVAL_MS = 2_000;
const MAX_SAB_READ_FRAMES = 1_536;

type TWasmTransportMode = 'shared-array-buffer' | 'message-port';

type TDtlnModule = {
	dtln_create: () => number;
	dtln_destroy: (handle: number) => void;
	dtln_denoise: (handle: number, input: Float32Array, output: Float32Array) => boolean;
};

type TDtlnModuleNamespace = {
	default?: unknown;
	dtlnPluginReady?: PromiseLike<unknown>;
};

type TWorkerInitMessage = {
	type: 'init';
	sessionId: string;
	transportMode: TWasmTransportMode;
	moduleUrl: string;
	wasmUrl: string;
	controlPort: MessagePort;
	inputDataBuffer?: SharedArrayBuffer;
	inputStateBuffer?: SharedArrayBuffer;
	outputDataBuffer?: SharedArrayBuffer;
	outputStateBuffer?: SharedArrayBuffer;
};

type TWorkerShutdownMessage = {
	type: 'shutdown';
};

type TWorkerMessage = TWorkerInitMessage | TWorkerShutdownMessage;

type TControlInputMessage = {
	type: 'input';
	samples: Float32Array;
};

type TControlTelemetryMessage = {
	type: 'telemetry';
	transportMode: TWasmTransportMode;
	inputDrops: number;
	outputUnderruns: number;
	outputQueueFrames: number;
};

type TControlMessage = TControlInputMessage | TControlTelemetryMessage;

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

type TSharedRing = {
	data: Float32Array;
	state: Int32Array;
};

class Downsample48KhzTo16Khz {
	private carry: number[] = [];

	process(input: Float32Array): Float32Array {
		if (input.length === 0) {
			return new Float32Array(0);
		}

		const combined = new Float32Array(this.carry.length + input.length);
		for (let carryIndex = 0; carryIndex < this.carry.length; carryIndex += 1) {
			combined[carryIndex] = this.carry[carryIndex] ?? 0;
		}
		combined.set(input, this.carry.length);

		const outputLength = Math.floor(combined.length / 3);
		const output = new Float32Array(outputLength);

		for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
			const baseIndex = outputIndex * 3;
			output[outputIndex] = (combined[baseIndex] + combined[baseIndex + 1] + combined[baseIndex + 2]) / 3;
		}

		this.carry = Array.from(combined.subarray(outputLength * 3));

		return output;
	}

	reset() {
		this.carry = [];
	}
}

class Upsample16KhzTo48Khz {
	private previousSample: number | undefined;

	process(input: Float32Array): Float32Array {
		if (input.length === 0) {
			return new Float32Array(0);
		}

		const output = new Float32Array(input.length * 3);
		let outputIndex = 0;
		let previousSample = typeof this.previousSample === 'number' ? this.previousSample : input[0];

		for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) {
			const currentSample = input[inputIndex] ?? 0;

			output[outputIndex] = previousSample;
			output[outputIndex + 1] = previousSample + (currentSample - previousSample) / 3;
			output[outputIndex + 2] = previousSample + ((currentSample - previousSample) * 2) / 3;

			outputIndex += 3;
			previousSample = currentSample;
		}

		this.previousSample = previousSample;

		return output;
	}

	reset() {
		this.previousSample = undefined;
	}
}

class DtlnWasmRunner {
	private readonly module: TDtlnModule;
	private handle: number | undefined;

	constructor(module: TDtlnModule) {
		this.module = module;
	}

	init(): void {
		this.handle = this.module.dtln_create();
	}

	process(input: Float32Array): Float32Array {
		if (typeof this.handle !== 'number') {
			throw new Error('DTLN runner not initialized');
		}

		const output = new Float32Array(input.length);
		this.module.dtln_denoise(this.handle, input, output);
		return output;
	}

	destroy() {
		if (typeof this.handle === 'number') {
			this.module.dtln_destroy(this.handle);
			this.handle = undefined;
		}
	}
}

const isDtlnModule = (value: unknown): value is TDtlnModule => {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	return (
		'dtln_create' in value &&
		typeof Reflect.get(value, 'dtln_create') === 'function' &&
		'dtln_destroy' in value &&
		typeof Reflect.get(value, 'dtln_destroy') === 'function' &&
		'dtln_denoise' in value &&
		typeof Reflect.get(value, 'dtln_denoise') === 'function'
	);
};

const DTLN_WASM_URL_MARKER = 'var wasmBinaryFile;wasmBinaryFile=new URL("./dtln_rs.wasm",import.meta.url).toString();';
const DTLN_WASM_LOCATE_FILE_MARKER = 'if(!isDataURI(wasmBinaryFile)){wasmBinaryFile=locateFile(wasmBinaryFile)}';
const DTLN_STREAMING_INSTANTIATE_MARKER =
	'if(!wasmBinary&&typeof WebAssembly.instantiateStreaming=="function"&&!isDataURI(wasmBinaryFile)&&typeof fetch=="function"){';
const DTLN_READY_MARKER =
	'if(typeof self!=="undefined"){self.__sharkordDtlnPlugin=DtlnPlugin}Module.postRun=[()=>{console.log(`Finished loading DTLN plugin!!!`);DtlnPlugin.postRun&&DtlnPlugin.postRun.forEach(fn=>fn())}];\n\nexport default DtlnPlugin;';
const DTLN_READY_PATCH =
	'if(typeof self!=="undefined"){self.__sharkordDtlnPlugin=DtlnPlugin}let dtlnPluginReadyResolve;const dtlnPluginReady=new Promise(resolve=>{dtlnPluginReadyResolve=resolve});Module.postRun=[()=>{console.log(`Finished loading DTLN plugin!!!`);dtlnPluginReadyResolve(DtlnPlugin);DtlnPlugin.postRun&&DtlnPlugin.postRun.forEach(fn=>fn())}];\n\nexport { dtlnPluginReady };\nexport default DtlnPlugin;';

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	return 'then' in value && typeof Reflect.get(value, 'then') === 'function';
};

const resolveDtlnModule = async ({
	moduleUrl,
	wasmUrl,
}: {
	moduleUrl: string;
	wasmUrl: string;
}): Promise<TDtlnModule> => {
	const response = await fetch(moduleUrl);

	if (!response.ok) {
		throw new Error(`Unable to fetch DTLN browser module (${response.status})`);
	}

	const moduleSource = await response.text();
	const moduleSourceWithWasmUrl = moduleSource.replace(
		DTLN_WASM_URL_MARKER,
		`var wasmBinaryFile=${JSON.stringify(wasmUrl)};`,
	);

	if (moduleSourceWithWasmUrl === moduleSource) {
		throw new Error('Unable to patch DTLN browser module wasm URL');
	}

	const moduleSourceWithDirectWasmUrl = moduleSourceWithWasmUrl.replace(DTLN_WASM_LOCATE_FILE_MARKER, '');

	if (moduleSourceWithDirectWasmUrl === moduleSourceWithWasmUrl) {
		throw new Error('Unable to patch DTLN browser module locateFile hook');
	}

	const moduleSourceWithReadyHook = moduleSourceWithDirectWasmUrl.replace(DTLN_READY_MARKER, DTLN_READY_PATCH);

	if (moduleSourceWithReadyHook === moduleSourceWithDirectWasmUrl) {
		throw new Error('Unable to patch DTLN browser module readiness hook');
	}

	const patchedModuleSource = moduleSourceWithReadyHook.replace(DTLN_STREAMING_INSTANTIATE_MARKER, 'if(false){');

	if (patchedModuleSource === moduleSourceWithReadyHook) {
		throw new Error('Unable to patch DTLN browser module streaming instantiation');
	}

	const moduleBlobUrl = URL.createObjectURL(
		new Blob([patchedModuleSource], {
			type: 'text/javascript',
		}),
	);

	let moduleNamespace: TDtlnModuleNamespace | undefined;

	try {
		const importedModuleNamespace: unknown = await import(/* @vite-ignore */ moduleBlobUrl);

		if (typeof importedModuleNamespace === 'object' && importedModuleNamespace !== null) {
			moduleNamespace = importedModuleNamespace;
		}
	} finally {
		URL.revokeObjectURL(moduleBlobUrl);
	}

	if (moduleNamespace?.dtlnPluginReady && isPromiseLike(moduleNamespace.dtlnPluginReady)) {
		await moduleNamespace.dtlnPluginReady;
	}

	if (moduleNamespace && 'default' in moduleNamespace) {
		const defaultExport = moduleNamespace.default;

		if (isDtlnModule(defaultExport)) {
			return defaultExport;
		}
	}

	if (isDtlnModule(moduleNamespace)) {
		return moduleNamespace;
	}

	throw new Error('Unsupported DTLN wasm module shape');
};

const getSharedRingAvailableFrames = (state: Int32Array): number => {
	return Atomics.load(state, 2);
};

const readSharedRing = (ring: TSharedRing, maxFrames: number): Float32Array => {
	const framesToRead = Math.min(maxFrames, getSharedRingAvailableFrames(ring.state));

	if (framesToRead <= 0) {
		return new Float32Array(0);
	}

	const output = new Float32Array(framesToRead);
	let readIndex = Atomics.load(ring.state, 0);

	for (let frameIndex = 0; frameIndex < framesToRead; frameIndex += 1) {
		output[frameIndex] = ring.data[readIndex] ?? 0;
		readIndex = (readIndex + 1) % ring.data.length;
	}

	Atomics.store(ring.state, 0, readIndex);
	Atomics.sub(ring.state, 2, framesToRead);

	return output;
};

const writeSharedRing = (ring: TSharedRing, samples: Float32Array): number => {
	const capacity = ring.data.length;
	const available = getSharedRingAvailableFrames(ring.state);
	const freeFrames = Math.max(0, capacity - available);
	const framesToWrite = Math.min(samples.length, freeFrames);
	let writeIndex = Atomics.load(ring.state, 1);

	for (let frameIndex = 0; frameIndex < framesToWrite; frameIndex += 1) {
		ring.data[writeIndex] = samples[frameIndex] ?? 0;
		writeIndex = (writeIndex + 1) % capacity;
	}

	Atomics.store(ring.state, 1, writeIndex);
	Atomics.add(ring.state, 2, framesToWrite);

	return framesToWrite;
};

let sessionId = '';
let transportMode: TWasmTransportMode = 'message-port';
let controlPort: MessagePort | undefined;
let inputRing: TSharedRing | undefined;
let outputRing: TSharedRing | undefined;
let sabPollTimerId: number | undefined;
let statsTimerId: number | undefined;
let runner: DtlnWasmRunner | undefined;
let totalProcessTimeMs = 0;
let maxProcessTimeMs = 0;
let processedBlocks = 0;
let outputDrops = 0;
let reportedInputDrops = 0;
let reportedOutputUnderruns = 0;
let reportedOutputQueueFrames = 0;
const pendingInput16Khz: number[] = [];
const downsampler = new Downsample48KhzTo16Khz();
const upsampler = new Upsample16KhzTo48Khz();

const postError = (error: unknown) => {
	const message = error instanceof Error ? error.message : 'Unknown DTLN worker error';
	self.postMessage({
		type: 'error',
		error: message,
	});
};

const postStats = () => {
	const stats: TWorkerStats = {
		sessionId,
		transportMode,
		processedBlocks,
		averageProcessTimeMs: processedBlocks > 0 ? totalProcessTimeMs / processedBlocks : null,
		maxProcessTimeMs: processedBlocks > 0 ? maxProcessTimeMs : null,
		inputQueueFrames: pendingInput16Khz.length * 3,
		outputQueueFrames:
			transportMode === 'shared-array-buffer' && outputRing
				? getSharedRingAvailableFrames(outputRing.state)
				: reportedOutputQueueFrames,
		inputDrops: reportedInputDrops,
		outputDrops,
		outputUnderruns: reportedOutputUnderruns,
	};

	self.postMessage({
		type: 'stats',
		stats,
	});
};

const emitProcessed48Khz = (samples: Float32Array) => {
	if (!controlPort) {
		return;
	}

	if (transportMode === 'shared-array-buffer') {
		if (!outputRing) {
			return;
		}

		const writtenFrames = writeSharedRing(outputRing, samples);
		outputDrops += samples.length - writtenFrames;
		return;
	}

	controlPort.postMessage(
		{
			type: 'output',
			samples,
		},
		[samples.buffer],
	);
};

const processPending16KhzBlocks = () => {
	if (!runner) {
		return;
	}

	while (pendingInput16Khz.length >= DTLN_BLOCK_SIZE_16_KHZ) {
		const block = pendingInput16Khz.splice(0, DTLN_BLOCK_SIZE_16_KHZ);
		const inputBlock = Float32Array.from(block);
		const processStart = performance.now();
		const processedBlock = runner.process(inputBlock);
		const processDuration = performance.now() - processStart;
		const upsampledOutput = upsampler.process(processedBlock);

		totalProcessTimeMs += processDuration;
		maxProcessTimeMs = Math.max(maxProcessTimeMs, processDuration);
		processedBlocks += 1;

		emitProcessed48Khz(upsampledOutput);
	}
};

const handleInput48Khz = (samples: Float32Array) => {
	const downsampledSamples = downsampler.process(samples);

	for (let sampleIndex = 0; sampleIndex < downsampledSamples.length; sampleIndex += 1) {
		pendingInput16Khz.push(downsampledSamples[sampleIndex] ?? 0);
	}

	processPending16KhzBlocks();
};

const pumpSharedInput = () => {
	if (transportMode !== 'shared-array-buffer' || !inputRing) {
		return;
	}

	while (getSharedRingAvailableFrames(inputRing.state) > 0) {
		const inputChunk = readSharedRing(inputRing, MAX_SAB_READ_FRAMES);

		if (inputChunk.length === 0) {
			break;
		}

		handleInput48Khz(inputChunk);
	}
};

const handleControlMessage = (message: TControlMessage) => {
	if (message.type === 'input') {
		handleInput48Khz(message.samples);
		return;
	}

	reportedInputDrops = message.inputDrops;
	reportedOutputUnderruns = message.outputUnderruns;
	reportedOutputQueueFrames = message.outputQueueFrames;
};

const stopTimers = () => {
	if (typeof sabPollTimerId === 'number') {
		clearInterval(sabPollTimerId);
		sabPollTimerId = undefined;
	}

	if (typeof statsTimerId === 'number') {
		clearInterval(statsTimerId);
		statsTimerId = undefined;
	}
};

const destroyRunner = () => {
	runner?.destroy();
	runner = undefined;
};

const resetState = () => {
	stopTimers();
	destroyRunner();
	controlPort?.close();
	controlPort = undefined;
	inputRing = undefined;
	outputRing = undefined;
	sessionId = '';
	totalProcessTimeMs = 0;
	maxProcessTimeMs = 0;
	processedBlocks = 0;
	outputDrops = 0;
	reportedInputDrops = 0;
	reportedOutputUnderruns = 0;
	reportedOutputQueueFrames = 0;
	pendingInput16Khz.length = 0;
	downsampler.reset();
	upsampler.reset();
};

const initializeWorker = async (message: TWorkerInitMessage) => {
	resetState();

	sessionId = message.sessionId;
	transportMode = message.transportMode;
	controlPort = message.controlPort;
	controlPort.onmessage = (event: MessageEvent<TControlMessage>) => {
		handleControlMessage(event.data);
	};
	controlPort.start?.();

	if (transportMode === 'shared-array-buffer') {
		if (
			!message.inputDataBuffer ||
			!message.inputStateBuffer ||
			!message.outputDataBuffer ||
			!message.outputStateBuffer
		) {
			throw new Error('SharedArrayBuffer transport requires ring buffers');
		}

		inputRing = {
			data: new Float32Array(message.inputDataBuffer),
			state: new Int32Array(message.inputStateBuffer),
		};
		outputRing = {
			data: new Float32Array(message.outputDataBuffer),
			state: new Int32Array(message.outputStateBuffer),
		};
	}

	const module = await resolveDtlnModule({
		moduleUrl: message.moduleUrl,
		wasmUrl: message.wasmUrl,
	});

	runner = new DtlnWasmRunner(module);
	runner.init();

	if (transportMode === 'shared-array-buffer') {
		sabPollTimerId = self.setInterval(pumpSharedInput, SAB_POLL_INTERVAL_MS);
	}

	statsTimerId = self.setInterval(postStats, STATS_INTERVAL_MS);

	self.postMessage({
		type: 'ready',
		sessionId,
		transportMode,
		framesPerBlock48Khz: DTLN_BLOCK_SIZE_16_KHZ * 3,
	});
};

self.onmessage = (event: MessageEvent<TWorkerMessage>) => {
	const message = event.data;

	if (message.type === 'shutdown') {
		resetState();
		self.close();
		return;
	}

	void initializeWorker(message).catch(postError);
};

export {};
