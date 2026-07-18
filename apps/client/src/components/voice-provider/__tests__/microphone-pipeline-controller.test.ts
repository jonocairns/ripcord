import { describe, expect, it } from 'bun:test';
import {
	createMicrophonePipelineController,
	MicPipelineSupersededError,
	type TMicrophoneGainPipeline,
	type TMicrophonePipelineControllerPorts,
	type TMicrophoneProcessingPipeline,
} from '../microphone-pipeline-controller';

type TDeferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

const createDeferred = <T = void>(): TDeferred<T> => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});

	return { promise, resolve, reject };
};

const flushMicrotasks = async (): Promise<void> => {
	for (let turn = 0; turn < 8; turn += 1) {
		await Promise.resolve();
	}
};

type TFakeTrack = MediaStreamTrack & {
	stopCalls: number;
	emit: (type: 'mute' | 'unmute' | 'ended') => void;
	setMuted: (muted: boolean) => void;
};

const createTrack = (label: string, order?: string[]): TFakeTrack => {
	let muted = false;
	let readyState: MediaStreamTrackState = 'live';
	let stopCalls = 0;
	const listeners = new Map<string, Set<() => void>>();
	const track = {
		label,
		enabled: true,
		onended: null,
		get muted() {
			return muted;
		},
		get readyState() {
			return readyState;
		},
		get stopCalls() {
			return stopCalls;
		},
		getSettings: () => ({ deviceId: `${label}-device`, groupId: `${label}-group` }),
		stop() {
			stopCalls += 1;
			readyState = 'ended';
			order?.push(`stop:${label}`);
		},
		addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
			const callbacks = listeners.get(type) ?? new Set<() => void>();
			callbacks.add(listener as () => void);
			listeners.set(type, callbacks);
		},
		removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
			listeners.get(type)?.delete(listener as () => void);
		},
		emit(type: 'mute' | 'unmute' | 'ended') {
			for (const listener of listeners.get(type) ?? []) {
				listener();
			}
		},
		setMuted(nextMuted: boolean) {
			muted = nextMuted;
		},
	} as unknown as TFakeTrack;

	return track;
};

type TFakeStream = MediaStream & {
	track: TFakeTrack;
};

const createStream = (label: string, order?: string[]): TFakeStream => {
	const track = createTrack(label, order);
	return {
		track,
		getAudioTracks: () => [track],
		getTracks: () => [track],
	} as unknown as TFakeStream;
};

type TFakeProcessingPipeline = Omit<TMicrophoneProcessingPipeline, 'stream' | 'track'> & {
	stream: TFakeStream;
	track: TFakeTrack;
	destroyCalls: number;
	mutedValues: boolean[];
};

const createProcessingPipeline = (
	label: string,
	options: { destroyDeferred?: TDeferred<void>; order?: string[] } = {},
): TFakeProcessingPipeline => {
	const stream = createStream(label, options.order);
	return {
		stream,
		track: stream.track,
		destroyCalls: 0,
		mutedValues: [],
		setInputMuted(muted) {
			this.mutedValues.push(muted);
		},
		async destroy() {
			this.destroyCalls += 1;
			options.order?.push(`destroy:${label}`);
			await options.destroyDeferred?.promise;
		},
	};
};

type TFakeGainPipeline = Omit<TMicrophoneGainPipeline, 'stream' | 'track'> & {
	stream: TFakeStream;
	track: TFakeTrack;
	destroyCalls: number;
	volumeValues: number[];
};

const createGainPipeline = (
	label: string,
	options: { destroyDeferred?: TDeferred<void>; order?: string[] } = {},
): TFakeGainPipeline => {
	const stream = createStream(label, options.order);
	return {
		stream,
		track: stream.track,
		destroyCalls: 0,
		volumeValues: [],
		async destroy() {
			this.destroyCalls += 1;
			options.order?.push(`destroy:${label}`);
			await options.destroyDeferred?.promise;
		},
	};
};

type TFakeProducer = {
	id: string;
	closed: boolean;
	closeCalls: number;
	close: () => void;
	onClosed: (callback: () => void) => void;
};

type TFakeActivityMonitor = {
	producer: TFakeProducer;
	onUpdate: (isSpeaking: boolean | undefined) => void;
	cleanupCalls: number;
};

const createProducer = (id: string): TFakeProducer => {
	const closeListeners = new Set<() => void>();
	return {
		id,
		closed: false,
		closeCalls: 0,
		close() {
			if (this.closed) return;
			this.closed = true;
			this.closeCalls += 1;
			for (const listener of closeListeners) {
				listener();
			}
		},
		onClosed(callback) {
			closeListeners.add(callback);
		},
	};
};

const createManualScheduler = () => {
	let nextId = 0;
	const timers = new Map<number, () => void>();

	return {
		setTimeout: (handler: () => void) => {
			nextId += 1;
			timers.set(nextId, handler);
			return nextId as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
			timers.delete(handle as unknown as number);
		},
		runAll: () => {
			const pending = [...timers.values()];
			timers.clear();
			pending.forEach((handler) => handler());
		},
		pendingCount: () => timers.size,
	};
};

type THarness = ReturnType<typeof createHarness>;

const createHarness = (options: { activate?: boolean } = {}) => {
	type TFakePorts = TMicrophonePipelineControllerPorts<TFakeProducer, TFakeProcessingPipeline, TFakeGainPipeline>;

	const scheduler = createManualScheduler();
	const streams: TFakeStream[] = [];
	const producers: TFakeProducer[] = [];
	const publishedTracks: MediaStreamTrack[] = [];
	const removedLocalStreams: MediaStream[] = [];
	const serverClosedProducerIds: string[] = [];
	const activityUpdates: Array<{ isSpeaking: boolean | undefined; producerId: string | undefined }> = [];
	const activityMonitors: TFakeActivityMonitor[] = [];
	const rawRecoveries: string[] = [];
	const rawRecoveryExhaustions: string[] = [];
	let localStream: MediaStream | undefined;
	let transportGeneration = 1;
	let producerSequence = 0;
	let micMuted = false;
	let inVoiceChannel = true;
	let activityMode: 'monitor' | 'inactive' | 'unavailable' = 'monitor';
	let getUserMediaImpl: TFakePorts['getUserMedia'] = async (_constraints) => {
		const stream = createStream(`raw-${streams.length + 1}`);
		streams.push(stream);
		return stream;
	};
	let createProcessingPipelineImpl: TFakePorts['createProcessingPipeline'] = async (_input) => undefined;
	let createGainPipelineImpl: TFakePorts['createGainPipeline'] = async (_stream, _volume) => undefined;
	let publishProducerImpl: (track: MediaStreamTrack) => Promise<TFakeProducer> = async (_track) => {
		producerSequence += 1;
		const producer = createProducer(`producer-${producerSequence}`);
		producers.push(producer);
		return producer;
	};

	const ports: TFakePorts = {
		getUserMedia: (constraints) => getUserMediaImpl(constraints),
		createProcessingPipeline: (input) => createProcessingPipelineImpl(input),
		createGainPipeline: (stream, volume) => createGainPipelineImpl(stream, volume),
		setGainVolume: (pipeline, volume) => {
			pipeline.volumeValues.push(volume);
		},
		createProducerPublicationLease: () => {
			const generation = transportGeneration;
			return {
				publish: (track) => {
					publishedTracks.push(track);
					return publishProducerImpl(track);
				},
				isCurrent: () => generation === transportGeneration,
			};
		},
		publishLocalStream: (stream) => {
			localStream = stream;
			return {
				stream,
				remove: () => {
					if (localStream === stream) {
						localStream = undefined;
					}
					removedLocalStreams.push(stream);
				},
			};
		},
		getProducerId: (producer) => producer.id,
		isProducerClosed: (producer) => producer.closed,
		closeProducer: (producer) => producer.close(),
		observeProducerClosed: (producer, onClosed) => producer.onClosed(onClosed),
		closeProducerOnServer: (producerId) => {
			serverClosedProducerIds.push(producerId);
		},
		getActivityMode: () => activityMode,
		startActivityMonitor: (producer, onUpdate) => {
			const monitor: TFakeActivityMonitor = {
				producer,
				onUpdate,
				cleanupCalls: 0,
			};
			activityMonitors.push(monitor);
			onUpdate(undefined);
			return () => {
				monitor.cleanupCalls += 1;
			};
		},
		onActivityUpdate: (isSpeaking, producerId) => {
			activityUpdates.push({ isSpeaking, producerId });
		},
		isInVoiceChannel: () => inVoiceChannel,
		isMicMuted: () => micMuted,
		onRawLossRecover: (reason) => {
			rawRecoveries.push(reason);
		},
		onRawLossExhausted: (reason) => {
			rawRecoveryExhaustions.push(reason);
		},
		onProcessingRuntimeError: () => {},
		setTimeout: scheduler.setTimeout,
		clearTimeout: scheduler.clearTimeout,
	};

	const controller = createMicrophonePipelineController(ports);
	if (options.activate ?? true) {
		controller.activate();
	}

	return {
		controller,
		scheduler,
		streams,
		producers,
		publishedTracks,
		removedLocalStreams,
		serverClosedProducerIds,
		activityUpdates,
		activityMonitors,
		rawRecoveries,
		rawRecoveryExhaustions,
		get localStream() {
			return localStream;
		},
		setMicMuted: (value: boolean) => {
			micMuted = value;
		},
		setInVoiceChannel: (value: boolean) => {
			inVoiceChannel = value;
		},
		setActivityMode: (value: 'monitor' | 'inactive' | 'unavailable') => {
			activityMode = value;
		},
		replaceTransport: () => {
			transportGeneration += 1;
		},
		setGetUserMedia: (implementation: typeof getUserMediaImpl) => {
			getUserMediaImpl = implementation;
		},
		setCreateProcessingPipeline: (implementation: typeof createProcessingPipelineImpl) => {
			createProcessingPipelineImpl = implementation;
		},
		setCreateGainPipeline: (implementation: typeof createGainPipelineImpl) => {
			createGainPipelineImpl = implementation;
		},
		setPublishProducer: (implementation: typeof publishProducerImpl) => {
			publishProducerImpl = implementation;
		},
	};
};

const prepare = (
	harness: THarness,
	overrides: Partial<{ processingEnabled: boolean; gainVolume: number; isCurrent: () => boolean }> = {},
) =>
	harness.controller.prepare({
		constraints: {},
		processingEnabled: overrides.processingEnabled ?? true,
		gainVolume: overrides.gainVolume ?? 100,
		isCurrent: overrides.isCurrent,
	});

describe('microphone pipeline controller lifecycle', () => {
	it('survives lifecycle replay while fencing a deferred predecessor from its published successor', async () => {
		const harness = createHarness({ activate: false });
		const firstCapture = createDeferred<MediaStream>();
		const successorCapture = createDeferred<MediaStream>();
		const captures = [firstCapture, successorCapture];
		let captureCalls = 0;
		harness.setGetUserMedia(() => {
			captureCalls += 1;
			return captures.shift()?.promise ?? Promise.reject(new Error('unexpected capture'));
		});

		await expect(prepare(harness)).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(captureCalls).toBe(0);

		harness.controller.activate();
		const predecessorLease = harness.controller.createLifecycleLease();
		const predecessorPrepare = prepare(harness);
		await flushMicrotasks();
		expect(captureCalls).toBe(1);

		await harness.controller.deactivate();
		expect(predecessorLease.isCurrent()).toBe(false);
		harness.controller.activate();

		const successorPrepare = prepare(harness);
		await flushMicrotasks();
		const successorStream = createStream('successor');
		successorCapture.resolve(successorStream);
		const successor = await successorPrepare;
		await harness.controller.publish({ source: successor });

		const staleStream = createStream('stale');
		firstCapture.resolve(staleStream);
		await expect(predecessorPrepare).rejects.toBeInstanceOf(MicPipelineSupersededError);

		expect(staleStream.track.stopCalls).toBe(1);
		expect(successorStream.track.stopCalls).toBe(0);
		expect(harness.controller.owns(successor)).toBe(true);
		expect(harness.producers[0]?.closed).toBe(false);
		expect(harness.activityMonitors).toHaveLength(1);
	});

	it('rejects a pre-replay caller before it can clean up the published successor', async () => {
		const harness = createHarness();
		const predecessorLease = harness.controller.createLifecycleLease();

		await harness.controller.deactivate();
		harness.controller.activate();

		const successorStream = createStream('successor');
		harness.setGetUserMedia(async () => successorStream);
		const successor = await prepare(harness);
		await harness.controller.publish({ source: successor });

		let staleCaptureCalls = 0;
		harness.setGetUserMedia(async () => {
			staleCaptureCalls += 1;
			return createStream('unexpected-stale');
		});

		await expect(prepare(harness, { isCurrent: predecessorLease.isCurrent })).rejects.toBeInstanceOf(
			MicPipelineSupersededError,
		);

		expect(staleCaptureCalls).toBe(0);
		expect(successorStream.track.stopCalls).toBe(0);
		expect(harness.controller.owns(successor)).toBe(true);
		expect(harness.producers[0]?.closed).toBe(false);
		expect(harness.activityMonitors).toHaveLength(1);
	});

	it('does not acquire media when caller currency expires during old graph cleanup', async () => {
		const harness = createHarness();
		const gainDestroy = createDeferred<void>();
		const existingGain = createGainPipeline('existing-gain', { destroyDeferred: gainDestroy });
		let captureCalls = 0;
		harness.setGetUserMedia(async () => {
			captureCalls += 1;
			return createStream(`capture-${captureCalls}`);
		});
		harness.setCreateGainPipeline(async () => existingGain);

		await prepare(harness);
		expect(captureCalls).toBe(1);

		let callerCurrent = true;
		const cancelledPrepare = prepare(harness, { isCurrent: () => callerCurrent });
		await flushMicrotasks();
		expect(existingGain.destroyCalls).toBe(1);

		callerCurrent = false;
		gainDestroy.resolve();

		await expect(cancelledPrepare).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(captureCalls).toBe(1);
		expect(harness.controller.getRawTrack()).toBeUndefined();
	});

	it('stops a deferred capture when caller currency expires before capture resolves', async () => {
		const harness = createHarness();
		const capture = createDeferred<MediaStream>();
		let callerCurrent = true;
		let processingCalls = 0;
		harness.setGetUserMedia(() => capture.promise);
		harness.setCreateProcessingPipeline(async () => {
			processingCalls += 1;
			return undefined;
		});

		const cancelledPrepare = prepare(harness, { isCurrent: () => callerCurrent });
		await flushMicrotasks();
		callerCurrent = false;
		const staleStream = createStream('stale-capture');
		capture.resolve(staleStream);

		await expect(cancelledPrepare).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(staleStream.track.stopCalls).toBe(1);
		expect(processingCalls).toBe(0);
		expect(harness.controller.getRawTrack()).toBeUndefined();
	});

	it('prevents a queued late preparation from acquiring media after final deactivation', async () => {
		const harness = createHarness();
		const queueGate = createDeferred<void>();
		let captureCalls = 0;
		harness.setGetUserMedia(async () => {
			captureCalls += 1;
			return createStream('unexpected');
		});
		const latePrepare = queueGate.promise.then(() => prepare(harness));

		await harness.controller.deactivate();
		queueGate.resolve();

		await expect(latePrepare).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(captureCalls).toBe(0);
	});
});

describe('microphone pipeline controller ownership', () => {
	it('stops a deferred old getUserMedia result without touching its successor', async () => {
		const harness = createHarness();
		const firstCapture = createDeferred<MediaStream>();
		const secondCapture = createDeferred<MediaStream>();
		const captures = [firstCapture, secondCapture];
		harness.setGetUserMedia(() => captures.shift()?.promise ?? Promise.reject(new Error('unexpected capture')));

		const firstPrepare = prepare(harness);
		await flushMicrotasks();
		const secondPrepare = prepare(harness);
		await flushMicrotasks();
		const successorStream = createStream('successor');
		secondCapture.resolve(successorStream);
		const successor = await secondPrepare;
		const staleStream = createStream('stale');
		firstCapture.resolve(staleStream);

		await expect(firstPrepare).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(staleStream.track.stopCalls).toBe(1);
		expect(successorStream.track.stopCalls).toBe(0);
		expect(harness.controller.owns(successor)).toBe(true);
		expect(harness.controller.getRawTrack()).toBe(successorStream.track);
	});

	it('keeps the later build installed when an older cleanup resolves last', async () => {
		const harness = createHarness();
		const oldDestroy = createDeferred<void>();
		const oldGain = createGainPipeline('old-gain', { destroyDeferred: oldDestroy });
		let gainCall = 0;
		harness.setCreateGainPipeline(async () => {
			gainCall += 1;
			return gainCall === 1 ? oldGain : undefined;
		});

		await prepare(harness, { gainVolume: 50 });
		const oldCleanup = harness.controller.cleanup();
		const successor = await prepare(harness);

		expect(harness.controller.owns(successor)).toBe(true);
		oldDestroy.resolve();
		await oldCleanup;

		expect(harness.controller.owns(successor)).toBe(true);
		expect(harness.controller.getRawTrack()?.readyState).toBe('live');
	});

	for (const outcome of ['falsey', 'rejection'] as const) {
		it(`does not let a stale ${outcome} processing result clear the successor`, async () => {
			const harness = createHarness();
			const oldProcessing = createDeferred<TFakeProcessingPipeline | undefined>();
			const successorProcessing = createProcessingPipeline('successor-processing');
			let call = 0;
			harness.setCreateProcessingPipeline(() => {
				call += 1;
				return call === 1 ? oldProcessing.promise : Promise.resolve(successorProcessing);
			});

			const firstPrepare = prepare(harness);
			await flushMicrotasks();
			const successor = await prepare(harness);
			if (outcome === 'falsey') {
				oldProcessing.resolve(undefined);
			} else {
				oldProcessing.reject(new Error('processing unavailable'));
			}

			await expect(firstPrepare).rejects.toBeInstanceOf(MicPipelineSupersededError);
			harness.controller.setMuted(true);
			expect(successorProcessing.mutedValues).toEqual([true]);
			expect(harness.controller.owns(successor)).toBe(true);
		});
	}

	for (const outcome of ['falsey', 'rejection'] as const) {
		it(`does not let a stale ${outcome} gain result clear the successor`, async () => {
			const harness = createHarness();
			const oldGain = createDeferred<TFakeGainPipeline | undefined>();
			const successorGain = createGainPipeline('successor-gain');
			let call = 0;
			harness.setCreateGainPipeline(() => {
				call += 1;
				return call === 1 ? oldGain.promise : Promise.resolve(successorGain);
			});

			const firstPrepare = prepare(harness, { gainVolume: 50 });
			await flushMicrotasks();
			const successor = await prepare(harness, { gainVolume: 50 });
			if (outcome === 'falsey') {
				oldGain.resolve(undefined);
			} else {
				oldGain.reject(new Error('gain unavailable'));
			}

			await expect(firstPrepare).rejects.toBeInstanceOf(MicPipelineSupersededError);
			harness.controller.setGainVolume(25);
			expect(successorGain.volumeValues).toEqual([25]);
			expect(harness.controller.owns(successor)).toBe(true);
		});
	}

	it('destroys a processing resource created after supersession exactly once and never publishes it', async () => {
		const harness = createHarness();
		const oldProcessingResult = createDeferred<TFakeProcessingPipeline | undefined>();
		const oldProcessing = createProcessingPipeline('old-processing');
		let call = 0;
		harness.setCreateProcessingPipeline(() => {
			call += 1;
			return call === 1 ? oldProcessingResult.promise : Promise.resolve(undefined);
		});

		const firstPrepare = prepare(harness);
		await flushMicrotasks();
		const successor = await prepare(harness);
		await harness.controller.publish({ source: successor });
		oldProcessingResult.resolve(oldProcessing);

		await expect(firstPrepare).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(oldProcessing.destroyCalls).toBe(1);
		expect(harness.publishedTracks).not.toContain(oldProcessing.track);
	});

	it('destroys a gain resource created after supersession exactly once and never publishes it', async () => {
		const harness = createHarness();
		const oldGainResult = createDeferred<TFakeGainPipeline | undefined>();
		const oldGain = createGainPipeline('old-gain');
		let call = 0;
		harness.setCreateGainPipeline(() => {
			call += 1;
			return call === 1 ? oldGainResult.promise : Promise.resolve(undefined);
		});

		const firstPrepare = prepare(harness, { gainVolume: 50 });
		await flushMicrotasks();
		const successor = await prepare(harness);
		await harness.controller.publish({ source: successor });
		oldGainResult.resolve(oldGain);

		await expect(firstPrepare).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(oldGain.destroyCalls).toBe(1);
		expect(harness.publishedTracks).not.toContain(oldGain.track);
	});
});

describe('microphone pipeline controller publication', () => {
	it('propagates mute state to the outbound track and processing input', async () => {
		const harness = createHarness();
		const processing = createProcessingPipeline('processing');
		harness.setMicMuted(true);
		harness.setCreateProcessingPipeline(async () => processing);

		const prepared = await prepare(harness);
		await harness.controller.publish({ source: prepared });

		expect(prepared.outboundAudioTrack.enabled).toBe(false);
		expect(processing.mutedValues).toEqual([true]);

		harness.controller.setMuted(false);
		expect(prepared.outboundAudioTrack.enabled).toBe(true);
		expect(processing.mutedValues).toEqual([true, false]);
	});

	it('accepts activity only from the installed producer identity', async () => {
		const harness = createHarness();
		const firstPrepared = await prepare(harness);
		await harness.controller.publish({ source: firstPrepared });
		const firstMonitor = harness.activityMonitors[0];

		const successor = await prepare(harness);
		await harness.controller.publish({ source: successor });
		const successorMonitor = harness.activityMonitors[1];
		if (!firstMonitor || !successorMonitor) {
			throw new Error('Expected an activity monitor for each published producer');
		}
		const updatesBeforeSamples = harness.activityUpdates.length;

		firstMonitor.onUpdate(true);
		expect(harness.activityUpdates).toHaveLength(updatesBeforeSamples);

		successorMonitor.onUpdate(true);
		expect(harness.activityUpdates.at(-1)).toEqual({
			isSpeaking: true,
			producerId: successorMonitor.producer.id,
		});
		expect(firstMonitor.cleanupCalls).toBe(1);
	});

	it('starts activity monitoring when user identity becomes available', async () => {
		const harness = createHarness();
		harness.setActivityMode('unavailable');
		const prepared = await prepare(harness);
		await harness.controller.publish({ source: prepared });

		expect(harness.activityMonitors).toHaveLength(0);

		harness.setActivityMode('monitor');
		harness.controller.syncActivity();

		expect(harness.activityMonitors).toHaveLength(1);
		expect(harness.activityMonitors[0]?.producer).toBe(harness.producers[0]);
	});

	it('closes only a stale publish success and keeps the successor installed', async () => {
		const harness = createHarness();
		const stalePublish = createDeferred<TFakeProducer>();
		const staleProducer = createProducer('stale-producer');
		const successorProducer = createProducer('successor-producer');
		let publishCall = 0;
		harness.setPublishProducer(() => {
			publishCall += 1;
			return publishCall === 1 ? stalePublish.promise : Promise.resolve(successorProducer);
		});

		const stalePrepared = await prepare(harness);
		const stalePublication = harness.controller.publish({ source: stalePrepared });
		await flushMicrotasks();
		const successorPrepared = await prepare(harness);
		await harness.controller.publish({ source: successorPrepared });
		stalePublish.resolve(staleProducer);

		await expect(stalePublication).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(staleProducer.closeCalls).toBe(1);
		expect(successorProducer.closeCalls).toBe(0);
		expect(harness.serverClosedProducerIds).toContain('stale-producer');

		await harness.controller.cleanup();
		expect(successorProducer.closeCalls).toBe(1);
	});

	it('does not let a stale publish failure clean up the successor', async () => {
		const harness = createHarness();
		const stalePublish = createDeferred<TFakeProducer>();
		const successorProducer = createProducer('successor-producer');
		let publishCall = 0;
		harness.setPublishProducer(() => {
			publishCall += 1;
			return publishCall === 1 ? stalePublish.promise : Promise.resolve(successorProducer);
		});

		const stalePrepared = await prepare(harness);
		const stalePublication = harness.controller.publish({ source: stalePrepared });
		await flushMicrotasks();
		const successorPrepared = await prepare(harness);
		await harness.controller.publish({ source: successorPrepared });
		stalePublish.reject(new Error('old transport failed'));

		await expect(stalePublication).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(harness.controller.owns(successorPrepared)).toBe(true);
		expect(successorProducer.closed).toBe(false);
		expect(successorPrepared.outboundAudioTrack.readyState).toBe('live');
	});

	it('fences a late producer when the transport or session is replaced', async () => {
		for (const invalidation of ['transport', 'session'] as const) {
			const harness = createHarness();
			const producerResult = createDeferred<TFakeProducer>();
			const producer = createProducer(`${invalidation}-producer`);
			let sessionCurrent = true;
			harness.setPublishProducer(() => producerResult.promise);
			const prepared = await prepare(harness);
			const publication = harness.controller.publish({
				source: prepared,
				isCurrent: () => sessionCurrent,
			});
			await flushMicrotasks();

			if (invalidation === 'transport') {
				harness.replaceTransport();
			} else {
				sessionCurrent = false;
			}
			producerResult.resolve(producer);

			await expect(publication).rejects.toBeInstanceOf(MicPipelineSupersededError);
			expect(producer.closeCalls).toBe(1);
		}
	});

	it('ignores an ended callback from a superseded output track', async () => {
		const harness = createHarness();
		const firstProcessing = createProcessingPipeline('first-processing');
		const successorProcessing = createProcessingPipeline('successor-processing');
		let processingCall = 0;
		harness.setCreateProcessingPipeline(async () => {
			processingCall += 1;
			return processingCall === 1 ? firstProcessing : successorProcessing;
		});

		const firstPrepared = await prepare(harness);
		await harness.controller.publish({ source: firstPrepared });
		const staleEndedHandler = firstPrepared.outboundAudioTrack.onended;
		const successor = await prepare(harness);
		await harness.controller.publish({ source: successor });
		staleEndedHandler?.call(firstPrepared.outboundAudioTrack, new Event('ended'));
		await flushMicrotasks();

		expect(harness.controller.owns(successor)).toBe(true);
		expect(successorProcessing.destroyCalls).toBe(0);
		expect(successor.outboundAudioTrack.readyState).toBe('live');
	});
});

describe('microphone pipeline controller cleanup and raw loss', () => {
	it('captures only its producer, streams, pipelines, activity, and local publication before awaiting', async () => {
		const order: string[] = [];
		const harness = createHarness();
		const gainDestroy = createDeferred<void>();
		const processingDestroy = createDeferred<void>();
		const processing = createProcessingPipeline('processing', { destroyDeferred: processingDestroy, order });
		const gain = createGainPipeline('gain', { destroyDeferred: gainDestroy, order });
		harness.setGetUserMedia(async () => createStream('raw', order));
		harness.setCreateProcessingPipeline(async () => processing);
		harness.setCreateGainPipeline(async () => gain);

		const prepared = await prepare(harness, { gainVolume: 50 });
		await harness.controller.publish({ source: prepared });
		const producer = harness.producers[0];
		const cleanup = harness.controller.cleanup();

		expect(producer?.closed).toBe(true);
		expect(harness.activityMonitors[0]?.cleanupCalls).toBe(1);
		expect(gain.track.stopCalls).toBe(1);
		expect(harness.removedLocalStreams).toEqual([prepared.outboundStream]);
		expect(order.indexOf('stop:gain')).toBeLessThan(order.indexOf('destroy:gain'));
		expect(order.indexOf('stop:raw')).toBeLessThan(order.indexOf('destroy:gain'));

		gainDestroy.resolve();
		await flushMicrotasks();
		expect(processing.destroyCalls).toBe(1);
		processingDestroy.resolve();
		await cleanup;

		expect(gain.destroyCalls).toBe(1);
		expect(processing.destroyCalls).toBe(1);
		expect(harness.localStream).toBeUndefined();
	});

	it('recovers sustained raw loss, ignores a self-healed mute, and tears down while muted', async () => {
		const harness = createHarness();
		const prepared = await prepare(harness);
		await harness.controller.publish({ source: prepared });
		const rawTrack = harness.controller.getRawTrack();
		if (!rawTrack || !('emit' in rawTrack) || !('setMuted' in rawTrack)) {
			throw new Error('expected fake raw track');
		}
		const fakeRawTrack = rawTrack as TFakeTrack;

		fakeRawTrack.setMuted(true);
		fakeRawTrack.emit('mute');
		fakeRawTrack.setMuted(false);
		fakeRawTrack.emit('unmute');
		harness.scheduler.runAll();
		expect(harness.rawRecoveries).toEqual([]);

		fakeRawTrack.setMuted(true);
		fakeRawTrack.emit('mute');
		harness.scheduler.runAll();
		expect(harness.rawRecoveries).toEqual(['mute']);

		harness.setMicMuted(true);
		fakeRawTrack.emit('ended');
		await flushMicrotasks();
		expect(harness.controller.owns(prepared)).toBe(false);
		expect(harness.localStream).toBeUndefined();
	});

	it('stops capture after bounded consecutive raw-loss recovery attempts', async () => {
		const harness = createHarness();

		for (let attempt = 0; attempt < 4; attempt += 1) {
			const prepared = await prepare(harness);
			await harness.controller.publish({ source: prepared });
			const rawTrack = harness.controller.getRawTrack();
			if (!rawTrack || !('emit' in rawTrack)) {
				throw new Error('expected fake raw track');
			}

			(rawTrack as TFakeTrack).emit('ended');
			await flushMicrotasks();
		}

		expect(harness.rawRecoveries).toEqual(['ended', 'ended', 'ended']);
		expect(harness.rawRecoveryExhaustions).toEqual(['ended']);
		expect(harness.localStream).toBeUndefined();
		expect(harness.producers.every((producer) => producer.closed)).toBe(true);
	});

	it('restores the raw-loss recovery budget after a stable publication', async () => {
		const harness = createHarness();
		let prepared = await prepare(harness);
		await harness.controller.publish({ source: prepared });
		const firstTrack = harness.controller.getRawTrack();
		if (!firstTrack || !('emit' in firstTrack)) {
			throw new Error('expected fake raw track');
		}
		(firstTrack as TFakeTrack).emit('ended');

		prepared = await prepare(harness);
		await harness.controller.publish({ source: prepared });
		harness.scheduler.runAll();
		const stableTrack = harness.controller.getRawTrack();
		if (!stableTrack || !('emit' in stableTrack)) {
			throw new Error('expected fake raw track');
		}
		(stableTrack as TFakeTrack).emit('ended');

		expect(harness.rawRecoveries).toEqual(['ended', 'ended']);
		expect(harness.rawRecoveryExhaustions).toEqual([]);
	});
});
