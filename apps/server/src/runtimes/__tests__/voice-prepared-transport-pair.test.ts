import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ServerEvents, StreamKind, type TTransportParams } from '@sharkord/shared';
import type { AppData, Consumer, Producer, WebRtcTransport } from 'mediasoup/types';
import { pubsub } from '../../utils/pubsub';
import { VoiceRuntime } from '../voice';

const CHANNEL_BASE = 98_000;
let channelCounter = 0;

type TDeferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

const createDeferred = <T>(): TDeferred<T> => {
	let resolvePromise: (value: T) => void = () => {};
	let rejectPromise: (error: unknown) => void = () => {};
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});

	return {
		promise,
		resolve: resolvePromise,
		reject: rejectPromise,
	};
};

const makeTransportParams = (id: string): TTransportParams => ({
	id,
	iceParameters: {
		usernameFragment: `${id}-username`,
		password: `${id}-password`,
	},
	iceCandidates: [],
	dtlsParameters: {
		role: 'auto',
		fingerprints: [],
	},
});

const makeControlledTransport = (id: string, fireObserverOnClose = true) => {
	const observerCloseHandlers = new Set<() => void>();
	const dtlsStateHandlers = new Set<(state: 'failed') => void>();
	let observerCloseDelivered = false;
	let closed = false;
	let closeCalls = 0;

	const fireObserverClose = () => {
		if (observerCloseDelivered) {
			return;
		}

		observerCloseDelivered = true;
		for (const handler of observerCloseHandlers) {
			handler();
		}
	};

	const transport = {
		id,
		get closed() {
			return closed;
		},
		observer: {
			on: (event: string, handler: () => void) => {
				if (event === 'close') {
					observerCloseHandlers.add(handler);
				}
			},
		},
		on: (event: string, handler: (state: 'failed') => void) => {
			if (event === 'dtlsstatechange') {
				dtlsStateHandlers.add(handler);
			}
		},
		close: () => {
			closeCalls += 1;

			if (closed) {
				return;
			}

			closed = true;
			if (fireObserverOnClose) {
				fireObserverClose();
			}
		},
	} as unknown as WebRtcTransport<AppData>;

	return {
		transport,
		params: makeTransportParams(id),
		fireObserverClose,
		fireDtlsFailure: () => {
			for (const handler of dtlsStateHandlers) {
				handler('failed');
			}
		},
		get closeCalls() {
			return closeCalls;
		},
	};
};

type TControlledTransport = ReturnType<typeof makeControlledTransport>;

const makeCloseResource = <TResource extends Producer<AppData> | Consumer<AppData>>(id: string) => {
	const closeHandlers = new Set<() => void>();
	let closed = false;
	let closeCalls = 0;

	const resource = {
		id,
		get closed() {
			return closed;
		},
		observer: {
			on: (event: string, handler: () => void) => {
				if (event === 'close') {
					closeHandlers.add(handler);
				}
			},
		},
		close: () => {
			closeCalls += 1;

			if (closed) {
				return;
			}

			closed = true;
			for (const handler of closeHandlers) {
				handler();
			}
		},
	} as unknown as TResource;

	return {
		resource,
		get closeCalls() {
			return closeCalls;
		},
	};
};

const useTransportAllocations = (runtime: VoiceRuntime, allocations: Array<Promise<TControlledTransport>>) => {
	let allocationIndex = 0;

	return spyOn(runtime, 'createTransport').mockImplementation(async () => {
		const allocation = allocations[allocationIndex];
		allocationIndex += 1;

		if (!allocation) {
			throw new Error(`Unexpected transport allocation ${allocationIndex}`);
		}

		const controlledTransport = await allocation;
		return {
			transport: controlledTransport.transport,
			params: controlledTransport.params,
		};
	});
};

const resolvedAllocation = (transport: TControlledTransport) => Promise.resolve(transport);

describe('VoiceRuntime prepared transport pairs', () => {
	const runtimes: VoiceRuntime[] = [];

	afterEach(async () => {
		for (const runtime of runtimes) {
			runtime.removeProducerTransport(1);
			runtime.removeConsumerTransport(1);
			await runtime.destroy();
		}

		runtimes.length = 0;
	});

	const makeRuntime = () => {
		const runtime = new VoiceRuntime(CHANNEL_BASE + ++channelCounter);
		runtimes.push(runtime);
		return runtime;
	};

	test('prepares both sides privately without changing the active pair or its resources', async () => {
		const runtime = makeRuntime();
		const activeProducer = makeControlledTransport('active-producer');
		const activeConsumer = makeControlledTransport('active-consumer');
		const preparedProducer = makeControlledTransport('prepared-producer');
		const preparedConsumer = makeControlledTransport('prepared-consumer');
		useTransportAllocations(runtime, [
			resolvedAllocation(activeProducer),
			resolvedAllocation(activeConsumer),
			resolvedAllocation(preparedProducer),
			resolvedAllocation(preparedConsumer),
		]);

		const activePair = await runtime.prepareTransportPair(1);
		activePair.commit();
		const producer = makeCloseResource<Producer<AppData>>('active-audio');
		const consumer = makeCloseResource<Consumer<AppData>>('active-consumer-resource');
		runtime.addProducer(1, StreamKind.AUDIO, producer.resource);
		runtime.addConsumer(1, 2, StreamKind.AUDIO, consumer.resource);

		const preparedPair = await runtime.prepareTransportPair(1);

		expect(preparedPair.producerParams.id).toBe('prepared-producer');
		expect(preparedPair.consumerParams.id).toBe('prepared-consumer');
		expect(runtime.getProducerTransport(1)).toBe(activeProducer.transport);
		expect(runtime.getConsumerTransport(1)).toBe(activeConsumer.transport);
		expect(activeProducer.closeCalls).toBe(0);
		expect(activeConsumer.closeCalls).toBe(0);
		expect(producer.closeCalls).toBe(0);
		expect(consumer.closeCalls).toBe(0);

		await preparedPair.dispose();
	});

	test('producer allocation failure closes a consumer that completes later', async () => {
		const runtime = makeRuntime();
		const producerAllocation = createDeferred<TControlledTransport>();
		const consumerAllocation = createDeferred<TControlledTransport>();
		const consumer = makeControlledTransport('late-consumer');
		useTransportAllocations(runtime, [producerAllocation.promise, consumerAllocation.promise]);
		const failure = new Error('producer allocation failed');

		const preparation = runtime.prepareTransportPair(1);
		producerAllocation.reject(failure);
		await expect(preparation).rejects.toBe(failure);

		consumerAllocation.resolve(consumer);
		await Promise.resolve();
		await Promise.resolve();

		expect(consumer.closeCalls).toBe(1);
		expect(runtime.getProducerTransport(1)).toBeUndefined();
		expect(runtime.getConsumerTransport(1)).toBeUndefined();
	});

	test('consumer allocation failure closes a producer that already completed', async () => {
		const runtime = makeRuntime();
		const producerAllocation = createDeferred<TControlledTransport>();
		const consumerAllocation = createDeferred<TControlledTransport>();
		const producer = makeControlledTransport('late-producer');
		useTransportAllocations(runtime, [producerAllocation.promise, consumerAllocation.promise]);
		const failure = new Error('consumer allocation failed');

		const preparation = runtime.prepareTransportPair(1);
		producerAllocation.resolve(producer);
		await Promise.resolve();
		consumerAllocation.reject(failure);
		await expect(preparation).rejects.toBe(failure);

		expect(producer.closeCalls).toBe(1);
		expect(runtime.getProducerTransport(1)).toBeUndefined();
		expect(runtime.getConsumerTransport(1)).toBeUndefined();
	});

	test('dispose is idempotent, leaves the active pair selected, and prevents commit', async () => {
		const runtime = makeRuntime();
		const activeProducer = makeControlledTransport('active-producer');
		const activeConsumer = makeControlledTransport('active-consumer');
		const preparedProducer = makeControlledTransport('prepared-producer');
		const preparedConsumer = makeControlledTransport('prepared-consumer');
		useTransportAllocations(runtime, [
			resolvedAllocation(activeProducer),
			resolvedAllocation(activeConsumer),
			resolvedAllocation(preparedProducer),
			resolvedAllocation(preparedConsumer),
		]);
		const activePair = await runtime.prepareTransportPair(1);
		activePair.commit();
		const preparedPair = await runtime.prepareTransportPair(1);

		await preparedPair.dispose();
		await preparedPair.dispose();

		expect(preparedProducer.closeCalls).toBe(1);
		expect(preparedConsumer.closeCalls).toBe(1);
		expect(activeProducer.closeCalls).toBe(0);
		expect(activeConsumer.closeCalls).toBe(0);
		expect(runtime.getProducerTransport(1)).toBe(activeProducer.transport);
		expect(runtime.getConsumerTransport(1)).toBe(activeConsumer.transport);
		expect(() => preparedPair.commit()).toThrow('Voice transport pair is disposed');
	});

	test('commit replaces both sides before synchronous old close callbacks and cleans captured resources', async () => {
		const runtime = makeRuntime();
		const oldProducer = makeControlledTransport('old-producer');
		const oldConsumer = makeControlledTransport('old-consumer');
		const newProducer = makeControlledTransport('new-producer');
		const newConsumer = makeControlledTransport('new-consumer');
		useTransportAllocations(runtime, [
			resolvedAllocation(oldProducer),
			resolvedAllocation(oldConsumer),
			resolvedAllocation(newProducer),
			resolvedAllocation(newConsumer),
		]);
		const oldPair = await runtime.prepareTransportPair(1);
		oldPair.commit();
		const audioProducer = makeCloseResource<Producer<AppData>>('old-audio');
		const screenAudioProducer = makeCloseResource<Producer<AppData>>('old-screen-audio');
		const consumer = makeCloseResource<Consumer<AppData>>('old-consumer-resource');
		runtime.addProducer(1, StreamKind.AUDIO, audioProducer.resource);
		runtime.addProducer(1, StreamKind.SCREEN_AUDIO, screenAudioProducer.resource);
		runtime.addConsumer(1, 2, StreamKind.AUDIO, consumer.resource);
		const selectedPairsDuringClose: Array<[string | undefined, string | undefined]> = [];
		oldProducer.transport.observer.on('close', () => {
			selectedPairsDuringClose.push([runtime.getProducerTransport(1)?.id, runtime.getConsumerTransport(1)?.id]);
		});
		oldConsumer.transport.observer.on('close', () => {
			selectedPairsDuringClose.push([runtime.getProducerTransport(1)?.id, runtime.getConsumerTransport(1)?.id]);
		});

		const newPair = await runtime.prepareTransportPair(1);
		newPair.commit();
		newPair.commit();
		await newPair.dispose();

		expect(selectedPairsDuringClose).toEqual([
			['new-producer', 'new-consumer'],
			['new-producer', 'new-consumer'],
		]);
		expect(runtime.getProducerTransport(1)).toBe(newProducer.transport);
		expect(runtime.getConsumerTransport(1)).toBe(newConsumer.transport);
		expect(oldProducer.closeCalls).toBe(1);
		expect(oldConsumer.closeCalls).toBe(1);
		expect(audioProducer.closeCalls).toBe(1);
		expect(screenAudioProducer.closeCalls).toBe(1);
		expect(consumer.closeCalls).toBe(1);
		expect(newProducer.closeCalls).toBe(0);
		expect(newConsumer.closeCalls).toBe(0);
	});

	test('late old close callbacks cannot delete the committed successor', async () => {
		const runtime = makeRuntime();
		const oldProducer = makeControlledTransport('old-producer', false);
		const oldConsumer = makeControlledTransport('old-consumer', false);
		const newProducer = makeControlledTransport('new-producer');
		const newConsumer = makeControlledTransport('new-consumer');
		useTransportAllocations(runtime, [
			resolvedAllocation(oldProducer),
			resolvedAllocation(oldConsumer),
			resolvedAllocation(newProducer),
			resolvedAllocation(newConsumer),
		]);
		const oldPair = await runtime.prepareTransportPair(1);
		oldPair.commit();
		const newPair = await runtime.prepareTransportPair(1);
		newPair.commit();
		const successorProducer = makeCloseResource<Producer<AppData>>('successor-audio');
		const successorConsumer = makeCloseResource<Consumer<AppData>>('successor-consumer');
		runtime.addProducer(1, StreamKind.AUDIO, successorProducer.resource);
		runtime.addConsumer(1, 2, StreamKind.AUDIO, successorConsumer.resource);

		oldProducer.fireObserverClose();
		oldConsumer.fireObserverClose();

		expect(runtime.getProducerTransport(1)).toBe(newProducer.transport);
		expect(runtime.getConsumerTransport(1)).toBe(newConsumer.transport);
		expect(newProducer.closeCalls).toBe(0);
		expect(newConsumer.closeCalls).toBe(0);
		expect(successorProducer.closeCalls).toBe(0);
		expect(successorConsumer.closeCalls).toBe(0);
	});

	test('disposing another concurrent preparation cannot affect the committed pair', async () => {
		const runtime = makeRuntime();
		const currentProducer = makeControlledTransport('current-producer');
		const currentConsumer = makeControlledTransport('current-consumer');
		const staleProducer = makeControlledTransport('stale-producer');
		const staleConsumer = makeControlledTransport('stale-consumer');
		useTransportAllocations(runtime, [
			resolvedAllocation(currentProducer),
			resolvedAllocation(currentConsumer),
			resolvedAllocation(staleProducer),
			resolvedAllocation(staleConsumer),
		]);

		const currentPreparation = runtime.prepareTransportPair(1);
		const stalePreparation = runtime.prepareTransportPair(1);
		const [currentPair, stalePair] = await Promise.all([currentPreparation, stalePreparation]);
		currentPair.commit();
		await stalePair.dispose();

		expect(runtime.getProducerTransport(1)).toBe(currentProducer.transport);
		expect(runtime.getConsumerTransport(1)).toBe(currentConsumer.transport);
		expect(currentProducer.closeCalls).toBe(0);
		expect(currentConsumer.closeCalls).toBe(0);
		expect(staleProducer.closeCalls).toBe(1);
		expect(staleConsumer.closeCalls).toBe(1);
	});

	test('pre-commit DTLS failure disposes the private pair without publishing failure', async () => {
		const runtime = makeRuntime();
		const producer = makeControlledTransport('prepared-producer');
		const consumer = makeControlledTransport('prepared-consumer');
		useTransportAllocations(runtime, [resolvedAllocation(producer), resolvedAllocation(consumer)]);
		const publishSpy = spyOn(pubsub, 'publishFor');
		const pair = await runtime.prepareTransportPair(1);

		producer.fireDtlsFailure();

		expect(producer.closeCalls).toBe(1);
		expect(consumer.closeCalls).toBe(1);
		expect(publishSpy).not.toHaveBeenCalledWith(1, ServerEvents.VOICE_TRANSPORT_FAILED, expect.anything());
		expect(() => pair.commit()).toThrow('Voice transport pair is disposed');
		publishSpy.mockRestore();
	});

	test('committed DTLS failure removes only the failed active side and publishes failure', async () => {
		const runtime = makeRuntime();
		const producer = makeControlledTransport('committed-producer');
		const consumer = makeControlledTransport('committed-consumer');
		useTransportAllocations(runtime, [resolvedAllocation(producer), resolvedAllocation(consumer)]);
		const publishSpy = spyOn(pubsub, 'publishFor');
		const pair = await runtime.prepareTransportPair(1);
		pair.commit();

		producer.fireDtlsFailure();

		expect(runtime.getProducerTransport(1)).toBeUndefined();
		expect(runtime.getConsumerTransport(1)).toBe(consumer.transport);
		expect(producer.closeCalls).toBe(1);
		expect(consumer.closeCalls).toBe(0);
		expect(publishSpy).toHaveBeenCalledWith(1, ServerEvents.VOICE_TRANSPORT_FAILED, { userId: 1 });
		publishSpy.mockRestore();
	});

	test('user removal closes a committed pair and its associated resources', async () => {
		const runtime = makeRuntime();
		const producerTransport = makeControlledTransport('committed-producer');
		const consumerTransport = makeControlledTransport('committed-consumer');
		useTransportAllocations(runtime, [resolvedAllocation(producerTransport), resolvedAllocation(consumerTransport)]);
		runtime.addUser(1, { micMuted: false, soundMuted: false });
		const pair = await runtime.prepareTransportPair(1);
		pair.commit();
		const producer = makeCloseResource<Producer<AppData>>('audio-producer');
		const consumer = makeCloseResource<Consumer<AppData>>('audio-consumer');
		runtime.addProducer(1, StreamKind.AUDIO, producer.resource);
		runtime.addConsumer(1, 2, StreamKind.AUDIO, consumer.resource);

		runtime.removeUser(1);

		expect(runtime.getUser(1)).toBeUndefined();
		expect(runtime.getProducerTransport(1)).toBeUndefined();
		expect(runtime.getConsumerTransport(1)).toBeUndefined();
		expect(producerTransport.closeCalls).toBe(1);
		expect(consumerTransport.closeCalls).toBe(1);
		expect(producer.closeCalls).toBe(1);
		expect(consumer.closeCalls).toBe(1);
	});

	test('runtime destruction disposes prepared and later-created transports', async () => {
		const runtime = makeRuntime();
		const producerAllocation = createDeferred<TControlledTransport>();
		const consumerAllocation = createDeferred<TControlledTransport>();
		const producer = makeControlledTransport('prepared-producer');
		const consumer = makeControlledTransport('late-consumer');
		useTransportAllocations(runtime, [producerAllocation.promise, consumerAllocation.promise]);
		const preparation = runtime.prepareTransportPair(1);

		producerAllocation.resolve(producer);
		await Promise.resolve();
		await runtime.destroy();
		consumerAllocation.resolve(consumer);

		await expect(preparation).rejects.toThrow('Voice transport pair is disposed');
		expect(producer.closeCalls).toBe(1);
		expect(consumer.closeCalls).toBe(1);
	});

	test('runtime destruction invalidates a fully prepared handle', async () => {
		const runtime = makeRuntime();
		const producer = makeControlledTransport('prepared-producer');
		const consumer = makeControlledTransport('prepared-consumer');
		useTransportAllocations(runtime, [resolvedAllocation(producer), resolvedAllocation(consumer)]);
		const pair = await runtime.prepareTransportPair(1);

		await runtime.destroy();

		expect(producer.closeCalls).toBe(1);
		expect(consumer.closeCalls).toBe(1);
		expect(() => pair.commit()).toThrow('Voice transport pair is disposed');
	});
});
