import { describe, expect, it } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import {
	createRemoteMediaConsumeController,
	type TRemoteMediaConsumeRequest,
	type TServerConsumerAllocation,
} from '../remote-media-consume-controller';

type TTestRtpCapabilities = { tag: string };
type TTestConsumerRtpParameters = { tag: string };
type TTestTransport = { closed: boolean; id: string };

type TDeferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

const createDeferred = <T>(): TDeferred<T> => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});

	return { promise, resolve, reject };
};

class TTestLocalConsumer {
	closed = false;
	closeCount = 0;
	onClosed: (() => void) | undefined;

	constructor(
		readonly id: string,
		readonly producerId: string,
	) {}

	close = () => {
		if (this.closed) return;
		this.closed = true;
		this.closeCount += 1;
		this.onClosed?.();
	};
}

type TDelayWait = {
	milliseconds: number;
	resolve: () => void;
	settled: boolean;
};

const createScheduler = () => {
	const waits: TDelayWait[] = [];

	const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			const wait: TDelayWait = {
				milliseconds,
				settled: false,
				resolve: () => {
					if (wait.settled) return;
					wait.settled = true;
					resolve();
				},
			};
			waits.push(wait);

			const abort = () => {
				if (wait.settled) return;
				wait.settled = true;
				reject(new Error('delay aborted'));
			};

			if (signal.aborted) {
				abort();
				return;
			}

			signal.addEventListener('abort', abort, { once: true });
		});

	const resolveDelay = (milliseconds: number): void => {
		const wait = waits.find((candidate) => !candidate.settled && candidate.milliseconds === milliseconds);
		if (!wait) {
			throw new Error(`No active ${milliseconds}ms delay`);
		}
		wait.resolve();
	};

	return {
		delay,
		resolveDelay,
		activeDelays: () => waits.filter((wait) => !wait.settled).map((wait) => wait.milliseconds),
	};
};

const flush = async (): Promise<void> => {
	for (let index = 0; index < 8; index += 1) {
		await Promise.resolve();
	}
};

const allocation = (
	producerId: string,
	consumerId: string,
	kind: StreamKind = StreamKind.VIDEO,
): TServerConsumerAllocation<TTestConsumerRtpParameters> => ({
	producerId,
	consumerId,
	consumerKind: kind,
	consumerRtpParameters: { tag: consumerId },
});

const request = (
	remoteId: number,
	kind: StreamKind,
	expectedProducerId: string,
	options: { isManualRetry?: boolean; restartExisting?: boolean } = {},
): TRemoteMediaConsumeRequest<TTestRtpCapabilities> => ({
	remoteId,
	kind,
	expectedProducerId,
	rtpCapabilities: { tag: `${remoteId}-${kind}` },
	...options,
});

const createHarness = () => {
	const scheduler = createScheduler();
	const consumeDeferreds: TDeferred<TServerConsumerAllocation<TTestConsumerRtpParameters>>[] = [];
	const resumeDeferreds: TDeferred<void>[] = [];
	const closeCalls: { remoteId: number; kind: StreamKind; consumerId?: string }[] = [];
	const createdConsumers: TTestLocalConsumer[] = [];
	const attachedConsumerIds: string[] = [];
	const detachedConsumerIds: string[] = [];
	const startedTokens: number[] = [];
	const succeeded: { producerId: string; consumerId: string; operationToken: number }[] = [];
	const failedTokens: number[] = [];
	const consumerClosedIds: string[] = [];
	let localCreationError: unknown;

	const controller = createRemoteMediaConsumeController<
		TTestTransport,
		TTestLocalConsumer,
		TTestRtpCapabilities,
		TTestConsumerRtpParameters
	>({
		delay: scheduler.delay,
		getTransportId: (transport) => transport.id,
		isTransportClosed: (transport) => transport.closed,
		consumeOnServer: () => {
			const deferred = createDeferred<TServerConsumerAllocation<TTestConsumerRtpParameters>>();
			consumeDeferreds.push(deferred);
			return deferred.promise;
		},
		resumeServerConsumer: () => {
			const deferred = createDeferred<void>();
			resumeDeferreds.push(deferred);
			return deferred.promise;
		},
		closeServerConsumer: async (target) => {
			closeCalls.push(target);
		},
		createLocalConsumer: async (_transport, serverAllocation) => {
			if (localCreationError !== undefined) {
				throw localCreationError;
			}
			const consumer = new TTestLocalConsumer(serverAllocation.consumerId, serverAllocation.producerId);
			createdConsumers.push(consumer);
			return consumer;
		},
		closeLocalConsumer: (consumer) => consumer.close(),
		isLocalConsumerClosed: (consumer) => consumer.closed,
		observeLocalConsumerClosed: (consumer, onClosed) => {
			consumer.onClosed = onClosed;
		},
		attachLocalConsumer: (_consumeRequest, consumer) => {
			attachedConsumerIds.push(consumer.id);
			return () => {
				detachedConsumerIds.push(consumer.id);
			};
		},
		onConsumeStarted: (_consumeRequest, operationToken) => {
			startedTokens.push(operationToken);
		},
		onConsumeSucceeded: (_consumeRequest, result) => {
			succeeded.push(result);
		},
		onConsumeFailed: (_consumeRequest, result) => {
			failedTokens.push(result.operationToken);
		},
		onConsumerClosed: (_remoteId, _kind, consumerId) => {
			consumerClosedIds.push(consumerId);
		},
	});

	return {
		controller,
		scheduler,
		consumeDeferreds,
		resumeDeferreds,
		closeCalls,
		createdConsumers,
		attachedConsumerIds,
		detachedConsumerIds,
		startedTokens,
		succeeded,
		failedTokens,
		consumerClosedIds,
		setLocalCreationError: (error: unknown) => {
			localCreationError = error;
		},
	};
};

const installTransport = (harness: ReturnType<typeof createHarness>, id = 'transport-1'): TTestTransport => {
	const transport = { id, closed: false };
	harness.controller.replaceTransport(transport);
	return transport;
};

describe('remote media consume controller', () => {
	it('closes local and server resources when stopped after attachment but before resume', async () => {
		const harness = createHarness();
		installTransport(harness);

		const consume = harness.controller.consume(request(8, StreamKind.VIDEO, 'producer-8'));
		harness.consumeDeferreds[0].resolve(allocation('producer-8', 'consumer-8'));
		await flush();

		expect(harness.attachedConsumerIds).toEqual(['consumer-8']);
		harness.controller.cancel(8, StreamKind.VIDEO);
		await consume;
		await flush();

		expect(harness.createdConsumers[0].closed).toBe(true);
		expect(harness.detachedConsumerIds).toEqual(['consumer-8']);
		expect(harness.closeCalls).toContainEqual({
			remoteId: 8,
			kind: StreamKind.VIDEO,
			consumerId: 'consumer-8',
		});
		expect(harness.succeeded).toEqual([]);
	});

	it('cascades screen cancellation to an in-flight screen-audio consume', async () => {
		const harness = createHarness();
		installTransport(harness);

		const consume = harness.controller.consume(request(9, StreamKind.SCREEN_AUDIO, 'screen-audio-producer'));
		harness.controller.cancel(9, StreamKind.SCREEN);
		await consume;

		expect(harness.attachedConsumerIds).toEqual([]);
	});

	it('starts a fresh re-watch without letting the cancelled completion clear it', async () => {
		const harness = createHarness();
		installTransport(harness);

		const staleConsume = harness.controller.consume(request(10, StreamKind.VIDEO, 'producer-10'));
		harness.controller.cancel(10, StreamKind.VIDEO);
		const freshConsume = harness.controller.consume(request(10, StreamKind.VIDEO, 'producer-10'));

		harness.consumeDeferreds[1].resolve(allocation('producer-10', 'consumer-fresh'));
		await flush();
		harness.resumeDeferreds[0].resolve();
		await freshConsume;

		await staleConsume;

		expect(harness.succeeded).toEqual([{ producerId: 'producer-10', consumerId: 'consumer-fresh', operationToken: 2 }]);
		expect(harness.controller.getActiveConsumerProducerId(10, StreamKind.VIDEO)).toBe('producer-10');
	});

	it('invalidates every old operation when the consumer transport is replaced', async () => {
		const harness = createHarness();
		installTransport(harness, 'transport-old');

		const staleVideoConsume = harness.controller.consume(request(11, StreamKind.VIDEO, 'producer-11'));
		const staleAudioConsume = harness.controller.consume(
			request(11, StreamKind.SCREEN_AUDIO, 'screen-audio-producer-11'),
		);
		const oldGeneration = harness.controller.getTransportGeneration();
		installTransport(harness, 'transport-new');

		expect(harness.controller.getTransportGeneration()).toBeGreaterThan(oldGeneration);
		await Promise.all([staleVideoConsume, staleAudioConsume]);
		harness.consumeDeferreds[0].resolve(allocation('producer-11', 'consumer-old-transport'));
		harness.consumeDeferreds[1].resolve(
			allocation('screen-audio-producer-11', 'screen-audio-consumer-old-transport', StreamKind.SCREEN_AUDIO),
		);
		await flush();

		expect(harness.attachedConsumerIds).toEqual([]);
	});

	it('closes the server allocation when local creation fails', async () => {
		const harness = createHarness();
		installTransport(harness);
		harness.setLocalCreationError(new Error('local creation failed'));

		const consume = harness.controller.consume(request(13, StreamKind.VIDEO, 'producer-13'));
		harness.consumeDeferreds[0].resolve(allocation('producer-13', 'consumer-13'));
		await consume;

		expect(harness.closeCalls).toContainEqual({
			remoteId: 13,
			kind: StreamKind.VIDEO,
			consumerId: 'consumer-13',
		});
		expect(harness.failedTokens).toEqual([1]);
	});

	it('closes local and server resources when resume fails', async () => {
		const harness = createHarness();
		installTransport(harness);

		const consume = harness.controller.consume(request(14, StreamKind.VIDEO, 'producer-14'));
		harness.consumeDeferreds[0].resolve(allocation('producer-14', 'consumer-14'));
		await flush();
		harness.resumeDeferreds[0].reject(new Error('resume failed'));
		await consume;

		expect(harness.createdConsumers[0].closed).toBe(true);
		expect(harness.detachedConsumerIds).toEqual(['consumer-14']);
		expect(harness.closeCalls).toContainEqual({
			remoteId: 14,
			kind: StreamKind.VIDEO,
			consumerId: 'consumer-14',
		});
		expect(harness.failedTokens).toEqual([1]);
	});

	it('cannot commit success after the installed local consumer closes', async () => {
		const harness = createHarness();
		installTransport(harness);

		const consume = harness.controller.consume(request(14, StreamKind.VIDEO, 'producer-closed-locally'));
		harness.consumeDeferreds[0].resolve(allocation('producer-closed-locally', 'consumer-closed-locally'));
		await flush();
		harness.createdConsumers[0].close();
		harness.resumeDeferreds[0].resolve();
		await consume;

		expect(harness.succeeded).toEqual([]);
		expect(harness.closeCalls).toContainEqual({
			remoteId: 14,
			kind: StreamKind.VIDEO,
			consumerId: 'consumer-closed-locally',
		});
		expect(harness.failedTokens).toEqual([1]);
	});

	it('targets an older consumer close without closing the active replacement locally', async () => {
		const harness = createHarness();
		installTransport(harness);

		const consume = harness.controller.consume(request(14, StreamKind.VIDEO, 'producer-active'));
		harness.consumeDeferreds[0].resolve(allocation('producer-active', 'consumer-active'));
		await flush();
		harness.resumeDeferreds[0].resolve();
		await consume;

		await harness.controller.closeConsumer(14, StreamKind.VIDEO, 'consumer-predecessor');

		expect(harness.createdConsumers[0].closed).toBe(false);
		expect(harness.controller.getActiveConsumerProducerId(14, StreamKind.VIDEO)).toBe('producer-active');
		expect(harness.closeCalls).toContainEqual({
			remoteId: 14,
			kind: StreamKind.VIDEO,
			consumerId: 'consumer-predecessor',
		});
	});

	it('closes a committed server consumer when stop cancellation removes local state first', async () => {
		const harness = createHarness();
		installTransport(harness);

		const consume = harness.controller.consume(request(14, StreamKind.VIDEO, 'producer-stop'));
		harness.consumeDeferreds[0].resolve(allocation('producer-stop', 'consumer-stop'));
		await flush();
		harness.resumeDeferreds[0].resolve();
		await consume;

		harness.controller.cancel(14, StreamKind.VIDEO);
		await flush();

		expect(harness.createdConsumers[0].closed).toBe(true);
		expect(harness.detachedConsumerIds).toContain('consumer-stop');
		expect(harness.closeCalls).toContainEqual({
			remoteId: 14,
			kind: StreamKind.VIDEO,
			consumerId: 'consumer-stop',
		});
	});

	it('uses deterministic retry delays and cancels retry work immediately', async () => {
		const harness = createHarness();
		installTransport(harness);

		const consume = harness.controller.consume(request(15, StreamKind.AUDIO, 'producer-15'));
		harness.consumeDeferreds[0].reject(new Error('consume failed'));
		await flush();

		expect(harness.scheduler.activeDelays()).toEqual([500]);
		harness.scheduler.resolveDelay(500);
		await flush();
		expect(harness.consumeDeferreds).toHaveLength(2);

		harness.controller.cancel(15, StreamKind.AUDIO);
		await consume;

		expect(harness.scheduler.activeDelays()).toEqual([]);
		expect(harness.failedTokens).toEqual([]);
	});

	it('times out resume with injected time and closes the allocation', async () => {
		const harness = createHarness();
		installTransport(harness);

		const consume = harness.controller.consume(request(16, StreamKind.VIDEO, 'producer-16'));
		harness.consumeDeferreds[0].resolve(allocation('producer-16', 'consumer-16'));
		await flush();
		harness.scheduler.resolveDelay(10_000);
		await consume;

		expect(harness.createdConsumers[0].closed).toBe(true);
		expect(harness.closeCalls).toContainEqual({
			remoteId: 16,
			kind: StreamKind.VIDEO,
			consumerId: 'consumer-16',
		});
		expect(harness.failedTokens).toEqual([1]);
	});
});
