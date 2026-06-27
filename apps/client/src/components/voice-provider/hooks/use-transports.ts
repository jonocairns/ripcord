import { getMediasoupKind, StreamKind, type TRemoteProducerIds, type TTransportParams } from '@sharkord/shared';
import { TRPCClientError } from '@trpc/client';
import type { AppData, Consumer, Device, RtpCapabilities, Transport } from 'mediasoup-client/types';
import { useCallback, useRef } from 'react';
import { logVoice, traceSentrySpan } from '@/helpers/browser-logger';
import { getTRPCClient } from '@/lib/trpc';
import type { TRemoteUserStreamKinds } from '@/types';
import { withConsumeAttemptTimeout } from './consume-attempt-timeout';
import {
	createConsumeOperationState,
	finishConsumeOperation,
	reserveConsumeOperation,
	resetConsumeOperationGeneration,
} from './consume-operation-state';
import { getConsumeRetryDelayMs, shouldRetryConsume } from './consume-retry-policy';
import type { TExternalStreamTrackPresence } from './use-pending-streams';

// How long to wait for an ICE "disconnected" state to recover before closing
// the transport. ICE disconnected can be transient (brief packet loss / route
// change); only "failed" is terminal per the spec.
const ICE_DISCONNECT_GRACE_MS = 30_000;

type TConsumeAttemptResult = 'success' | 'failure';

type TServerConsumerCleanupTarget = {
	remoteId: number;
	kind: StreamKind;
	consumerId: string;
};

type TConsumeExistingProducersSweepRequest = {
	rtpCapabilities: RtpCapabilities;
	externalStreamTracks?: TExternalStreamTrackPresence;
	prefetchedProducers?: TRemoteProducerIds;
};

type TUseTransportParams = {
	addRemoteUserStream: (userId: number, stream: MediaStream, kind: TRemoteUserStreamKinds) => void;
	removeRemoteUserStream: (userId: number, kind: TRemoteUserStreamKinds) => void;
	addExternalStreamTrack: (
		streamId: number,
		stream: MediaStream,
		kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO,
	) => void;
	removeExternalStreamTrack: (streamId: number, kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO) => void;
	addPendingStream: (remoteId: number, kind: StreamKind, producerId?: string) => void;
	removePendingStream: (remoteId: number, kind: StreamKind) => void;
	clearAllPendingStreams: () => void;
	reconcilePendingStreams: (producers: TRemoteProducerIds, externalStreamTracks?: TExternalStreamTrackPresence) => void;
	onTransportFailure: () => void;
};

const useTransports = ({
	addRemoteUserStream,
	removeRemoteUserStream,
	addExternalStreamTrack,
	removeExternalStreamTrack,
	addPendingStream,
	removePendingStream,
	clearAllPendingStreams,
	reconcilePendingStreams,
	onTransportFailure,
}: TUseTransportParams) => {
	const producerTransport = useRef<Transport<AppData> | undefined>(undefined);
	const consumerTransport = useRef<Transport<AppData> | undefined>(undefined);
	const producerDisconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const consumerDisconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const consumers = useRef<{
		[userId: number]: {
			[kind: string]: Consumer<AppData>;
		};
	}>({});
	const consumeOperationState = useRef(createConsumeOperationState());
	const consumeExistingProducersInFlight = useRef<Promise<void> | undefined>(undefined);
	const queuedConsumeExistingProducersSweep = useRef<
		Omit<TConsumeExistingProducersSweepRequest, 'prefetchedProducers'> | undefined
	>(undefined);

	const closeServerConsumerAfterFailedConsume = useCallback(
		async (target: TServerConsumerCleanupTarget, reason: string, error?: unknown) => {
			try {
				await getTRPCClient().voice.closeConsumer.mutate({
					remoteId: target.remoteId,
					kind: target.kind,
					consumerId: target.consumerId,
				});
			} catch (closeError) {
				logVoice('Failed to close server consumer after failed consume', {
					closeError,
					error,
					reason,
					remoteId: target.remoteId,
					kind: target.kind,
					consumerId: target.consumerId,
				});
			}
		},
		[],
	);

	const createProducerTransport = useCallback(
		async (device: Device, prefetchedParams?: TTransportParams) => {
			logVoice('Creating producer transport', {
				device,
				prefetched: !!prefetchedParams,
			});

			const trpc = getTRPCClient();

			try {
				const params = prefetchedParams ?? (await trpc.voice.createProducerTransport.mutate());

				logVoice('Got producer transport parameters', { params });

				const transport = device.createSendTransport(params);
				producerTransport.current = transport;

				transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
					logVoice('Producer transport connected', { dtlsParameters });

					try {
						await trpc.voice.connectProducerTransport.mutate({
							dtlsParameters,
						});

						callback();
					} catch (error) {
						errback(error as Error);
						logVoice('Error connecting producer transport', { error });
					}
				});

				transport.on('connectionstatechange', (state) => {
					logVoice('Producer transport connection state changed', { state });

					if (producerDisconnectTimer.current !== undefined) {
						clearTimeout(producerDisconnectTimer.current);
						producerDisconnectTimer.current = undefined;
					}

					if (state === 'failed') {
						logVoice('Producer transport failed');

						if (producerTransport.current === transport && !transport.closed) {
							transport.close();
							onTransportFailure();
						}
					} else if (state === 'disconnected') {
						logVoice('Producer transport disconnected, attempting ICE restart...');

						void (async () => {
							try {
								const { iceParameters } = await getTRPCClient().voice.restartProducerIce.mutate();
								if (transport.connectionState !== 'connected' && !transport.closed) {
									await transport.restartIce({ iceParameters });
									logVoice('ICE restart initiated for producer transport');
								}
							} catch (error) {
								logVoice('ICE restart failed for producer transport', { error });
							}
						})();

						producerDisconnectTimer.current = setTimeout(() => {
							producerDisconnectTimer.current = undefined;

							if (
								producerTransport.current === transport &&
								transport.connectionState === 'disconnected' &&
								!transport.closed
							) {
								logVoice('Producer transport did not recover, closing');
								transport.close();
								onTransportFailure();
							}
						}, ICE_DISCONNECT_GRACE_MS);
					} else if (state === 'closed') {
						logVoice('Producer transport closed');

						if (producerTransport.current === transport) {
							producerTransport.current = undefined;
						}
					}
				});

				transport.on('icecandidateerror', (error) => {
					logVoice('Producer transport ICE candidate error', { error });
				});

				transport.on('produce', async ({ rtpParameters, appData }, callback, errback) => {
					logVoice('Producing new track', { rtpParameters, appData });

					const { kind } = appData as { kind: StreamKind };

					if (!producerTransport.current) {
						errback(new Error('Producer transport not available'));
						return;
					}

					try {
						const producerId = await trpc.voice.produce.mutate({
							transportId: producerTransport.current.id,
							kind,
							rtpParameters,
						});

						callback({ id: producerId });
					} catch (error) {
						if (error instanceof TRPCClientError) {
							if (error.data.code === 'FORBIDDEN') {
								logVoice('Permission denied to produce track', { kind });
								errback(new Error(`You don't have permission to ${kind} in this channel`));

								return;
							}
						}

						logVoice('Error producing new track', { error });
						errback(error as Error);
					}
				});
			} catch (error) {
				logVoice('Error creating producer transport', { error });
				throw error;
			}
		},
		[onTransportFailure],
	);

	const createConsumerTransport = useCallback(
		async (device: Device, prefetchedParams?: TTransportParams) => {
			logVoice('Creating consumer transport', {
				device,
				prefetched: !!prefetchedParams,
			});

			const trpc = getTRPCClient();

			try {
				const params = prefetchedParams ?? (await trpc.voice.createConsumerTransport.mutate());

				logVoice('Got consumer transport parameters', { params });

				const transport = device.createRecvTransport(params);
				consumerTransport.current = transport;
				resetConsumeOperationGeneration(consumeOperationState.current);

				transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
					logVoice('Consumer transport connected', { dtlsParameters });

					try {
						await trpc.voice.connectConsumerTransport.mutate({
							dtlsParameters,
						});

						callback();
					} catch (error) {
						errback(error as Error);
						logVoice('Consumer transport connect error', { error });
					}
				});

				const closeConsumerTransport = () => {
					if (consumerTransport.current !== transport) {
						return;
					}

					Object.values(consumers.current).forEach((userConsumers) => {
						Object.values(userConsumers).forEach((consumer) => {
							consumer.close();
						});
					});
					consumers.current = {};
					resetConsumeOperationGeneration(consumeOperationState.current);
					clearAllPendingStreams();

					if (!transport.closed) {
						transport.close();
					}

					if (consumerTransport.current === transport) {
						consumerTransport.current = undefined;
					}
				};

				transport.on('connectionstatechange', (state) => {
					logVoice('Consumer transport connection state changed', { state });

					if (consumerDisconnectTimer.current !== undefined) {
						clearTimeout(consumerDisconnectTimer.current);
						consumerDisconnectTimer.current = undefined;
					}

					if (state === 'failed') {
						logVoice('Consumer transport failed, cleaning up');
						if (consumerTransport.current === transport) {
							closeConsumerTransport();
							onTransportFailure();
						}
					} else if (state === 'disconnected') {
						logVoice('Consumer transport disconnected, attempting ICE restart...');

						void (async () => {
							try {
								const { iceParameters } = await getTRPCClient().voice.restartConsumerIce.mutate();
								if (transport.connectionState !== 'connected' && !transport.closed) {
									await transport.restartIce({ iceParameters });
									logVoice('ICE restart initiated for consumer transport');
								}
							} catch (error) {
								logVoice('ICE restart failed for consumer transport', { error });
							}
						})();

						consumerDisconnectTimer.current = setTimeout(() => {
							consumerDisconnectTimer.current = undefined;

							if (
								consumerTransport.current === transport &&
								transport.connectionState === 'disconnected' &&
								!transport.closed
							) {
								logVoice('Consumer transport did not recover, closing');
								closeConsumerTransport();
								onTransportFailure();
							}
						}, ICE_DISCONNECT_GRACE_MS);
					} else if (state === 'closed') {
						logVoice('Consumer transport closed');

						if (consumerTransport.current === transport) {
							consumerTransport.current = undefined;
							resetConsumeOperationGeneration(consumeOperationState.current);
						}
					}
				});

				transport.on('icecandidateerror', (error) => {
					logVoice('Consumer transport ICE candidate error', { error });
				});
			} catch (error) {
				logVoice('Failed to create consumer transport', { error });
				throw error;
			}
		},
		[clearAllPendingStreams, onTransportFailure],
	);

	const consumeOnce = useCallback(
		async (remoteId: number, kind: StreamKind, rtpCapabilities: RtpCapabilities): Promise<TConsumeAttemptResult> => {
			const transport = consumerTransport.current;
			let serverConsumerCleanupTarget: TServerConsumerCleanupTarget | undefined;

			if (!transport || transport.closed) {
				logVoice('Consumer transport not available');
				return 'failure';
			}

			try {
				logVoice('Consuming remote producer', { remoteId, kind });

				const trpc = getTRPCClient();

				const { producerId, consumerId, consumerKind, consumerRtpParameters } = await withConsumeAttemptTimeout(
					trpc.voice.consume.mutate({
						kind,
						remoteId,
						rtpCapabilities,
						paused: true,
					}),
				);
				serverConsumerCleanupTarget = { remoteId, kind, consumerId };

				if (consumerTransport.current !== transport || transport.closed) {
					logVoice('Consumer transport changed before local consumer creation', {
						remoteId,
						kind,
					});
					await closeServerConsumerAfterFailedConsume(
						serverConsumerCleanupTarget,
						'transport changed before local consumer creation',
					);
					return 'failure';
				}

				logVoice('Got consumer parameters', {
					producerId,
					consumerId,
					consumerKind,
					consumerRtpParameters,
				});

				if (!consumers.current[remoteId]) {
					consumers.current[remoteId] = {};
				}

				const existingConsumer = consumers.current[remoteId][consumerKind];

				if (existingConsumer && !existingConsumer.closed) {
					logVoice('Closing existing consumer before creating new one');

					existingConsumer.close();
					delete consumers.current[remoteId][consumerKind];
				}

				const newConsumer = await transport.consume({
					id: consumerId,
					producerId: producerId,
					kind: getMediasoupKind(consumerKind),
					rtpParameters: consumerRtpParameters,
					streamId: consumerRtpParameters.rtcp?.cname,
				});

				logVoice('Created new consumer', { newConsumer });

				const cleanupEvents = ['transportclose', 'trackended', '@close', 'close'];
				let cleanedUp = false;

				cleanupEvents.forEach((event) => {
					// @ts-expect-error - YOLO
					newConsumer?.on(event, () => {
						if (cleanedUp) return;

						const activeConsumer = consumers.current[remoteId]?.[consumerKind];
						if (activeConsumer && activeConsumer !== newConsumer) {
							return;
						}

						cleanedUp = true;

						logVoice(`Consumer cleanup event "${event}" triggered`, {
							remoteId,
							kind,
						});

						if (kind === StreamKind.EXTERNAL_VIDEO || kind === StreamKind.EXTERNAL_AUDIO) {
							removeExternalStreamTrack(remoteId, kind);
						} else {
							removeRemoteUserStream(remoteId, kind);
						}

						if (consumers.current[remoteId]?.[consumerKind]) {
							delete consumers.current[remoteId][consumerKind];
						}
					});
				});

				consumers.current[remoteId][consumerKind] = newConsumer;

				const stream = new MediaStream();

				stream.addTrack(newConsumer.track);

				if (kind === StreamKind.EXTERNAL_VIDEO || kind === StreamKind.EXTERNAL_AUDIO) {
					addExternalStreamTrack(remoteId, stream, kind);
				} else {
					addRemoteUserStream(remoteId, stream, kind);
				}

				try {
					await withConsumeAttemptTimeout(
						trpc.voice.resumeConsumer.mutate({
							remoteId,
							kind,
						}),
					);
				} catch (error) {
					logVoice('Error resuming remote consumer — closing stale consumer', {
						error,
						remoteId,
						kind,
					});

					newConsumer.close();
					await closeServerConsumerAfterFailedConsume(serverConsumerCleanupTarget, 'resume consumer failed', error);
					return 'failure';
				}

				serverConsumerCleanupTarget = undefined;
				removePendingStream(remoteId, kind);
				return 'success';
			} catch (error) {
				logVoice('Error consuming remote producer', { error });
				if (serverConsumerCleanupTarget !== undefined) {
					await closeServerConsumerAfterFailedConsume(serverConsumerCleanupTarget, 'consume attempt failed', error);
				}
				return 'failure';
			}
		},
		[
			addRemoteUserStream,
			removeRemoteUserStream,
			addExternalStreamTrack,
			removeExternalStreamTrack,
			removePendingStream,
			closeServerConsumerAfterFailedConsume,
		],
	);

	const consume = useCallback(
		async (remoteId: number, kind: StreamKind, rtpCapabilities: RtpCapabilities, expectedProducerId?: string) => {
			return traceSentrySpan(
				{
					name: 'voice.consume',
					op: 'voice.consume',
					attributes: {
						'voice.remote_id': remoteId,
						'voice.stream_kind': kind,
					},
				},
				async () => {
					const operationKey = `${remoteId}-${kind}`;
					const operation = reserveConsumeOperation(consumeOperationState.current, operationKey);

					if (operation === undefined) {
						logVoice('Consume operation already in progress', {
							remoteId,
							kind,
						});
						return;
					}

					let failedAttemptIndex = 0;

					addPendingStream(remoteId, kind, expectedProducerId);

					try {
						while (consumeOperationState.current.generation === operation.generation) {
							const result = await consumeOnce(remoteId, kind, rtpCapabilities);

							if (result === 'success') {
								return;
							}

							if (consumeOperationState.current.generation !== operation.generation) {
								break;
							}

							const retryDelayMs = getConsumeRetryDelayMs(kind, failedAttemptIndex);

							if (retryDelayMs === undefined) {
								logVoice('Remote consume failed without retry', {
									remoteId,
									kind,
									failedAttempts: failedAttemptIndex + 1,
								});
								if (!shouldRetryConsume(kind)) {
									removePendingStream(remoteId, kind);
								}
								return;
							}

							failedAttemptIndex += 1;

							logVoice('Retrying remote consume after failure', {
								remoteId,
								kind,
								nextAttempt: failedAttemptIndex + 1,
								retryDelayMs,
							});

							await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
						}

						logVoice('Aborting remote consume after transport generation changed', {
							remoteId,
							kind,
						});
					} finally {
						finishConsumeOperation(consumeOperationState.current, operationKey, operation);
					}
				},
			);
		},
		[addPendingStream, consumeOnce, removePendingStream],
	);

	const runConsumeExistingProducersSweep = useCallback(
		async ({ rtpCapabilities, externalStreamTracks, prefetchedProducers }: TConsumeExistingProducersSweepRequest) => {
			return traceSentrySpan(
				{
					name: 'voice.consume_existing_producers',
					op: 'voice.consume',
					attributes: {
						'voice.prefetched_producers': prefetchedProducers !== undefined,
					},
				},
				async () => {
					logVoice('Consuming existing producers', {
						rtpCapabilities,
						prefetched: !!prefetchedProducers,
					});

					const trpc = getTRPCClient();

					try {
						const producers = prefetchedProducers ?? (await trpc.voice.getProducers.query());
						const { remoteAudioIds, remoteScreenIds, remoteScreenAudioIds, remoteVideoIds, remoteExternalStreamIds } =
							producers;

						// The snapshot carries authoritative per-track presence; prefer it over
						// the caller-supplied local metadata, which can be stale on recovery and
						// would otherwise suppress a live external track that was just added.
						const effectiveExternalStreamTracks = producers.externalStreamTracks ?? externalStreamTracks;

						logVoice('Got existing producers', {
							remoteAudioIds,
							remoteScreenIds,
							remoteVideoIds,
							remoteExternalStreamIds,
						});

						await Promise.all(remoteAudioIds.map((remoteId) => consume(remoteId, StreamKind.AUDIO, rtpCapabilities)));

						remoteVideoIds.forEach((remoteId) => {
							addPendingStream(remoteId, StreamKind.VIDEO);
						});

						remoteScreenIds.forEach((remoteId) => {
							addPendingStream(remoteId, StreamKind.SCREEN);
						});

						remoteScreenAudioIds.forEach((remoteId) => {
							addPendingStream(remoteId, StreamKind.SCREEN_AUDIO);
						});

						remoteExternalStreamIds.forEach((streamId: number) => {
							const tracks = effectiveExternalStreamTracks?.[streamId];

							if (tracks?.audio !== false) {
								addPendingStream(streamId, StreamKind.EXTERNAL_AUDIO);
							}
							if (tracks?.video !== false) {
								addPendingStream(streamId, StreamKind.EXTERNAL_VIDEO);
							}
						});

						reconcilePendingStreams(producers, effectiveExternalStreamTracks);
					} catch (error) {
						logVoice('Error consuming existing producers', { error });
						throw error;
					}
				},
			);
		},
		[addPendingStream, consume, reconcilePendingStreams],
	);

	const consumeExistingProducers = useCallback(
		async (
			rtpCapabilities: RtpCapabilities,
			externalStreamTracks?: TExternalStreamTrackPresence,
			prefetchedProducers?: TRemoteProducerIds,
		) => {
			const activeSweep = consumeExistingProducersInFlight.current;

			if (activeSweep) {
				if (prefetchedProducers === undefined) {
					queuedConsumeExistingProducersSweep.current = { rtpCapabilities, externalStreamTracks };
					logVoice('Queued existing producer sync behind active sweep');
				} else {
					logVoice('Joining active existing producer sync');
				}

				return activeSweep;
			}

			const runQueuedSweeps = async () => {
				let nextSweep: TConsumeExistingProducersSweepRequest | undefined = {
					rtpCapabilities,
					externalStreamTracks,
					prefetchedProducers,
				};

				while (nextSweep !== undefined) {
					const currentSweep = nextSweep;
					nextSweep = undefined;

					await runConsumeExistingProducersSweep(currentSweep);

					const queuedSweep = queuedConsumeExistingProducersSweep.current;
					queuedConsumeExistingProducersSweep.current = undefined;

					if (queuedSweep !== undefined) {
						nextSweep = queuedSweep;
					}
				}
			};

			const sweepPromise = runQueuedSweeps().finally(() => {
				if (consumeExistingProducersInFlight.current === sweepPromise) {
					consumeExistingProducersInFlight.current = undefined;
				}
			});

			consumeExistingProducersInFlight.current = sweepPromise;

			return sweepPromise;
		},
		[runConsumeExistingProducersSweep],
	);

	const stopWatchingStream = useCallback(
		async (remoteId: number, kind: StreamKind) => {
			if (kind === StreamKind.AUDIO) {
				logVoice('Ignoring stop-watch request for audio stream', {
					remoteId,
					kind,
				});
				return;
			}

			const existingConsumer = consumers.current[remoteId]?.[kind];

			if (existingConsumer && !existingConsumer.closed) {
				existingConsumer.close();
			}

			addPendingStream(remoteId, kind);

			try {
				const trpc = getTRPCClient();

				await trpc.voice.closeConsumer.mutate({
					remoteId,
					kind,
				});
			} catch (error) {
				logVoice('Error closing remote consumer', {
					error,
					remoteId,
					kind,
				});
			}
		},
		[addPendingStream],
	);

	const cleanupTransports = useCallback(() => {
		logVoice('Cleaning up transports');

		if (producerDisconnectTimer.current !== undefined) {
			clearTimeout(producerDisconnectTimer.current);
			producerDisconnectTimer.current = undefined;
		}

		if (consumerDisconnectTimer.current !== undefined) {
			clearTimeout(consumerDisconnectTimer.current);
			consumerDisconnectTimer.current = undefined;
		}

		Object.values(consumers.current).forEach((userConsumers) => {
			Object.values(userConsumers).forEach((consumer) => {
				if (!consumer.closed) {
					consumer.close();
				}
			});
		});

		consumers.current = {};

		resetConsumeOperationGeneration(consumeOperationState.current);
		clearAllPendingStreams();

		if (producerTransport.current && !producerTransport.current.closed) {
			producerTransport.current.close();
		}

		producerTransport.current = undefined;

		if (consumerTransport.current && !consumerTransport.current.closed) {
			consumerTransport.current.close();
		}

		consumerTransport.current = undefined;

		logVoice('Transports cleanup complete');
	}, [clearAllPendingStreams]);

	const getActiveConsumerProducerId = useCallback(
		(remoteId: number, kind: StreamKind): string | undefined => consumers.current[remoteId]?.[kind]?.producerId,
		[],
	);

	return {
		producerTransport,
		consumerTransport,
		consumers,
		createProducerTransport,
		createConsumerTransport,
		consume,
		consumeExistingProducers,
		stopWatchingStream,
		cleanupTransports,
		getActiveConsumerProducerId,
	};
};

export { useTransports };
