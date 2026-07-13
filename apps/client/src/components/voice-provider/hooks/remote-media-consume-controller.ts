import { StreamKind } from '@sharkord/shared';
import { CONSUME_ATTEMPT_RPC_TIMEOUT_MS } from './consume-attempt-timeout';
import { getConsumeRetryDelayMs } from './consume-retry-policy';

type TRemoteMediaConsumeRequest<TRtpCapabilities> = {
	remoteId: number;
	kind: StreamKind;
	rtpCapabilities: TRtpCapabilities;
	expectedProducerId?: string;
	isManualRetry?: boolean;
	restartExisting?: boolean;
};

type TServerConsumerAllocation<TConsumerRtpParameters> = {
	producerId: string;
	consumerId: string;
	consumerKind: StreamKind;
	consumerRtpParameters: TConsumerRtpParameters;
};

type TServerConsumerTarget = {
	remoteId: number;
	kind: StreamKind;
	consumerId?: string;
};

type TRemoteMediaConsumeControllerPorts<
	TTransport extends object,
	TLocalConsumer extends object,
	TRtpCapabilities,
	TConsumerRtpParameters,
> = {
	delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	getTransportId: (transport: TTransport) => string;
	isTransportClosed: (transport: TTransport) => boolean;
	consumeOnServer: (
		request: TRemoteMediaConsumeRequest<TRtpCapabilities>,
		transportId: string,
	) => Promise<TServerConsumerAllocation<TConsumerRtpParameters>>;
	resumeServerConsumer: (target: Required<TServerConsumerTarget>) => Promise<void>;
	closeServerConsumer: (target: TServerConsumerTarget) => Promise<void>;
	createLocalConsumer: (
		transport: TTransport,
		allocation: TServerConsumerAllocation<TConsumerRtpParameters>,
	) => Promise<TLocalConsumer>;
	closeLocalConsumer: (consumer: TLocalConsumer) => void;
	isLocalConsumerClosed: (consumer: TLocalConsumer) => boolean;
	observeLocalConsumerClosed: (consumer: TLocalConsumer, onClosed: () => void) => void;
	attachLocalConsumer: (
		request: Pick<TRemoteMediaConsumeRequest<TRtpCapabilities>, 'remoteId' | 'kind'>,
		consumer: TLocalConsumer,
	) => () => void;
	onConsumeStarted: (request: TRemoteMediaConsumeRequest<TRtpCapabilities>, operationToken: number) => void;
	onConsumeSucceeded: (
		request: TRemoteMediaConsumeRequest<TRtpCapabilities>,
		result: { producerId: string; consumerId: string; operationToken: number },
	) => void;
	onConsumeFailed: (
		request: TRemoteMediaConsumeRequest<TRtpCapabilities>,
		result: { reason: string; operationToken: number },
	) => void;
	onConsumerClosed: (remoteId: number, kind: StreamKind, consumerId: string) => void;
	log?: (message: string, context?: Record<string, unknown>) => void;
	trace?: <T>(request: TRemoteMediaConsumeRequest<TRtpCapabilities>, operation: () => Promise<T>) => Promise<T>;
	rpcTimeoutMs?: number;
};

type TConsumeOperation<TTransport extends object, TRtpCapabilities> = {
	key: string;
	token: number;
	transportGeneration: number;
	transport: TTransport;
	request: TRemoteMediaConsumeRequest<TRtpCapabilities>;
	abortController: AbortController;
};

type TActiveConsumer<TLocalConsumer extends object> = {
	key: string;
	operationToken: number;
	transportGeneration: number;
	remoteId: number;
	kind: StreamKind;
	producerId: string;
	consumerId: string;
	consumer: TLocalConsumer;
	detach?: () => void;
	cleanedUp: boolean;
};

type TAttemptResult = 'success' | 'failure' | 'cancelled';

class VoiceRemoteMediaConsumeCancelledError extends Error {
	constructor() {
		super('Voice remote media consume cancelled');
		this.name = 'VoiceRemoteMediaConsumeCancelledError';
	}
}

class VoiceRemoteMediaConsumeTimeoutError extends Error {
	constructor() {
		super('Voice remote media consume boundary timed out');
		this.name = 'VoiceRemoteMediaConsumeTimeoutError';
	}
}

const getConsumeOperationKey = (remoteId: number, kind: StreamKind): string => `${remoteId}-${kind}`;

const createRemoteMediaConsumeController = <
	TTransport extends object,
	TLocalConsumer extends object,
	TRtpCapabilities,
	TConsumerRtpParameters,
>(
	ports: TRemoteMediaConsumeControllerPorts<TTransport, TLocalConsumer, TRtpCapabilities, TConsumerRtpParameters>,
) => {
	let currentTransport: TTransport | undefined;
	let transportGeneration = 0;
	let operationSequence = 0;
	let disposed = false;
	const operations = new Map<string, TConsumeOperation<TTransport, TRtpCapabilities>>();
	const activeConsumers = new Map<string, TActiveConsumer<TLocalConsumer>>();
	const rpcTimeoutMs = ports.rpcTimeoutMs ?? CONSUME_ATTEMPT_RPC_TIMEOUT_MS;

	const log = (message: string, context?: Record<string, unknown>): void => {
		ports.log?.(message, context);
	};

	const waitForBoundary = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			let settled = false;
			const timeoutAbortController = new AbortController();

			const cleanup = () => {
				signal.removeEventListener('abort', onAbort);
				timeoutAbortController.abort();
			};

			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new VoiceRemoteMediaConsumeCancelledError());
			};

			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener('abort', onAbort, { once: true });
			}

			operation.then(
				(value) => {
					if (settled) return;

					settled = true;
					cleanup();
					resolve(value);
				},
				(error: unknown) => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(error);
				},
			);

			void ports.delay(rpcTimeoutMs, timeoutAbortController.signal).then(
				() => {
					if (settled) return;
					settled = true;
					signal.removeEventListener('abort', onAbort);
					reject(new VoiceRemoteMediaConsumeTimeoutError());
				},
				(error: unknown) => {
					if (settled || timeoutAbortController.signal.aborted) return;
					settled = true;
					signal.removeEventListener('abort', onAbort);
					reject(error);
				},
			);
		});

	const closeServerConsumer = async (target: TServerConsumerTarget, reason: string): Promise<void> => {
		const boundaryController = new AbortController();
		try {
			await waitForBoundary(ports.closeServerConsumer(target), boundaryController.signal);
		} catch (error) {
			log('Failed to close server consumer', {
				error,
				reason,
				remoteId: target.remoteId,
				kind: target.kind,
				consumerId: target.consumerId,
			});
		}
	};

	const cleanupActiveConsumer = (
		record: TActiveConsumer<TLocalConsumer>,
		options: { closeLocal: boolean; notifyLedger: boolean },
	): void => {
		if (record.cleanedUp) return;
		record.cleanedUp = true;

		if (activeConsumers.get(record.key) === record) {
			activeConsumers.delete(record.key);
		}

		if (options.closeLocal && !ports.isLocalConsumerClosed(record.consumer)) {
			try {
				ports.closeLocalConsumer(record.consumer);
			} catch (error) {
				log('Failed to close local consumer', {
					error,
					remoteId: record.remoteId,
					kind: record.kind,
					consumerId: record.consumerId,
				});
			}
		}

		try {
			record.detach?.();
		} catch (error) {
			log('Failed to detach local consumer stream', {
				error,
				remoteId: record.remoteId,
				kind: record.kind,
				consumerId: record.consumerId,
			});
		}

		if (options.notifyLedger) {
			ports.onConsumerClosed(record.remoteId, record.kind, record.consumerId);
		}
	};

	const isOperationCurrent = (operation: TConsumeOperation<TTransport, TRtpCapabilities>): boolean =>
		!disposed &&
		!operation.abortController.signal.aborted &&
		operations.get(operation.key) === operation &&
		operation.transportGeneration === transportGeneration &&
		currentTransport === operation.transport &&
		!ports.isTransportClosed(operation.transport);

	const cancelOperation = (operation: TConsumeOperation<TTransport, TRtpCapabilities>): void => {
		if (operations.get(operation.key) === operation) {
			operations.delete(operation.key);
		}
		operation.abortController.abort();

		const activeConsumer = activeConsumers.get(operation.key);
		if (activeConsumer?.operationToken === operation.token) {
			cleanupActiveConsumer(activeConsumer, { closeLocal: true, notifyLedger: true });
		}
	};

	const runAttempt = async (operation: TConsumeOperation<TTransport, TRtpCapabilities>): Promise<TAttemptResult> => {
		const { request } = operation;
		let allocationOwned = false;
		let serverCleanupStarted = false;
		let allocation: TServerConsumerAllocation<TConsumerRtpParameters> | undefined;
		let localConsumer: TLocalConsumer | undefined;
		let activeRecord: TActiveConsumer<TLocalConsumer> | undefined;

		const cleanupServerAllocation = async (reason: string): Promise<void> => {
			if (!allocationOwned || serverCleanupStarted || allocation === undefined) return;
			serverCleanupStarted = true;
			await closeServerConsumer(
				{ remoteId: request.remoteId, kind: request.kind, consumerId: allocation.consumerId },
				reason,
			);
		};

		try {
			if (!isOperationCurrent(operation)) return 'cancelled';

			const consumePromise = ports.consumeOnServer(request, ports.getTransportId(operation.transport));
			allocation = await waitForBoundary(consumePromise, operation.abortController.signal);
			allocationOwned = true;

			if (allocation.consumerKind !== request.kind || !isOperationCurrent(operation)) {
				await cleanupServerAllocation('consume allocation superseded before local creation');
				return 'cancelled';
			}

			const existingConsumer = activeConsumers.get(operation.key);
			if (existingConsumer) {
				cleanupActiveConsumer(existingConsumer, { closeLocal: true, notifyLedger: true });
			}

			const localConsumerPromise = ports.createLocalConsumer(operation.transport, allocation);
			localConsumer = await waitForBoundary(localConsumerPromise, operation.abortController.signal);

			if (!isOperationCurrent(operation)) {
				if (!ports.isLocalConsumerClosed(localConsumer)) {
					ports.closeLocalConsumer(localConsumer);
				}
				await cleanupServerAllocation('consume superseded before local attachment');
				return 'cancelled';
			}

			activeRecord = {
				key: operation.key,
				operationToken: operation.token,
				transportGeneration: operation.transportGeneration,
				remoteId: request.remoteId,
				kind: request.kind,
				producerId: allocation.producerId,
				consumerId: allocation.consumerId,
				consumer: localConsumer,
				cleanedUp: false,
			};
			const installedRecord = activeRecord;
			ports.observeLocalConsumerClosed(localConsumer, () => {
				cleanupActiveConsumer(installedRecord, { closeLocal: false, notifyLedger: true });
			});
			activeConsumers.set(operation.key, activeRecord);
			activeRecord.detach = ports.attachLocalConsumer(request, localConsumer);

			await waitForBoundary(
				ports.resumeServerConsumer({
					remoteId: request.remoteId,
					kind: request.kind,
					consumerId: allocation.consumerId,
				}),
				operation.abortController.signal,
			);

			if (!isOperationCurrent(operation)) {
				cleanupActiveConsumer(activeRecord, { closeLocal: true, notifyLedger: true });
				await cleanupServerAllocation('consume superseded before success commit');
				return 'cancelled';
			}

			if (activeRecord.cleanedUp || activeConsumers.get(operation.key) !== activeRecord) {
				await cleanupServerAllocation('local consumer closed before success commit');
				return 'failure';
			}

			allocationOwned = false;
			ports.onConsumeSucceeded(request, {
				producerId: allocation.producerId,
				consumerId: allocation.consumerId,
				operationToken: operation.token,
			});
			return 'success';
		} catch (error) {
			if (activeRecord) {
				cleanupActiveConsumer(activeRecord, { closeLocal: true, notifyLedger: true });
			} else if (localConsumer && !ports.isLocalConsumerClosed(localConsumer)) {
				ports.closeLocalConsumer(localConsumer);
			}

			await cleanupServerAllocation('consume attempt failed');

			if (error instanceof VoiceRemoteMediaConsumeCancelledError || !isOperationCurrent(operation)) {
				return 'cancelled';
			}

			log('Remote media consume attempt failed', {
				error,
				remoteId: request.remoteId,
				kind: request.kind,
			});
			return 'failure';
		}
	};

	const runConsume = async (request: TRemoteMediaConsumeRequest<TRtpCapabilities>): Promise<void> => {
		if (disposed) return;

		const transport = currentTransport;
		if (!transport || ports.isTransportClosed(transport)) {
			log('Consumer transport not available', { remoteId: request.remoteId, kind: request.kind });
			return;
		}

		const key = getConsumeOperationKey(request.remoteId, request.kind);
		const existingOperation = operations.get(key);
		if (existingOperation && !request.restartExisting) {
			log('Consume operation already in progress', { remoteId: request.remoteId, kind: request.kind });
			return;
		}

		if (existingOperation) {
			cancelOperation(existingOperation);
		}

		operationSequence += 1;
		const operation: TConsumeOperation<TTransport, TRtpCapabilities> = {
			key,
			token: operationSequence,
			transportGeneration,
			transport,
			request,
			abortController: new AbortController(),
		};
		operations.set(key, operation);
		ports.onConsumeStarted(request, operation.token);

		let failedAttemptIndex = 0;

		try {
			while (isOperationCurrent(operation)) {
				const result = await runAttempt(operation);

				if (result === 'success' || result === 'cancelled' || !isOperationCurrent(operation)) {
					return;
				}

				const retryDelayMs = getConsumeRetryDelayMs(request.kind, failedAttemptIndex);
				if (retryDelayMs === undefined) {
					ports.onConsumeFailed(request, {
						reason: 'consume retry exhausted',
						operationToken: operation.token,
					});
					return;
				}

				failedAttemptIndex += 1;
				log('Retrying remote consume after failure', {
					remoteId: request.remoteId,
					kind: request.kind,
					nextAttempt: failedAttemptIndex + 1,
					retryDelayMs,
				});

				try {
					await ports.delay(retryDelayMs, operation.abortController.signal);
				} catch (error) {
					if (!operation.abortController.signal.aborted) {
						log('Remote consume retry delay failed', { error, remoteId: request.remoteId, kind: request.kind });
					}
					return;
				}
			}
		} finally {
			if (operations.get(key) === operation) {
				operations.delete(key);
			}
			operation.abortController.abort();
		}
	};

	const consume = (request: TRemoteMediaConsumeRequest<TRtpCapabilities>): Promise<void> => {
		const operation = () => runConsume(request);
		return ports.trace ? ports.trace(request, operation) : operation();
	};

	const cancelKey = (remoteId: number, kind: StreamKind): void => {
		const key = getConsumeOperationKey(remoteId, kind);
		const operation = operations.get(key);
		if (operation) {
			cancelOperation(operation);
		}

		const activeConsumer = activeConsumers.get(key);
		if (activeConsumer) {
			cleanupActiveConsumer(activeConsumer, { closeLocal: true, notifyLedger: true });
			void closeServerConsumer({ remoteId, kind, consumerId: activeConsumer.consumerId }, 'cancel active consumer');
		}
	};

	const cancel = (remoteId: number, kind: StreamKind): void => {
		cancelKey(remoteId, kind);
		if (kind === StreamKind.SCREEN) {
			cancelKey(remoteId, StreamKind.SCREEN_AUDIO);
		}
	};

	const closeConsumer = async (remoteId: number, kind: StreamKind, consumerId?: string): Promise<void> => {
		const key = getConsumeOperationKey(remoteId, kind);
		const activeConsumer = activeConsumers.get(key);
		const targetConsumerId = consumerId ?? activeConsumer?.consumerId;

		if (activeConsumer && (consumerId === undefined || consumerId === activeConsumer.consumerId)) {
			cleanupActiveConsumer(activeConsumer, { closeLocal: true, notifyLedger: true });
		}

		await closeServerConsumer({ remoteId, kind, consumerId: targetConsumerId }, 'explicit close');
	};

	const invalidateTransport = (): void => {
		currentTransport = undefined;
		transportGeneration += 1;

		const currentOperations = [...operations.values()];
		operations.clear();
		currentOperations.forEach((operation) => {
			operation.abortController.abort();
		});

		const currentConsumers = [...activeConsumers.values()];
		activeConsumers.clear();
		currentConsumers.forEach((consumer) => {
			cleanupActiveConsumer(consumer, { closeLocal: true, notifyLedger: true });
		});
	};

	const replaceTransport = (transport: TTransport): void => {
		if (disposed || currentTransport === transport) return;
		invalidateTransport();
		currentTransport = transport;
	};

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		invalidateTransport();
	};

	return {
		consume,
		cancel,
		closeConsumer,
		replaceTransport,
		invalidateTransport,
		getTransportGeneration: () => transportGeneration,
		getActiveConsumerProducerId: (remoteId: number, kind: StreamKind): string | undefined =>
			activeConsumers.get(getConsumeOperationKey(remoteId, kind))?.producerId,
		dispose,
	};
};

type TRemoteMediaConsumeController<
	TTransport extends object,
	TLocalConsumer extends object,
	TRtpCapabilities,
	TConsumerRtpParameters,
> = ReturnType<
	typeof createRemoteMediaConsumeController<TTransport, TLocalConsumer, TRtpCapabilities, TConsumerRtpParameters>
>;

export type { TRemoteMediaConsumeController, TRemoteMediaConsumeRequest, TServerConsumerAllocation };
export { createRemoteMediaConsumeController };
