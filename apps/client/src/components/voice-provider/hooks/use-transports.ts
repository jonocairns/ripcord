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
	isCurrentConsumeOperation,
	reserveConsumeOperation,
	resetConsumeOperationGeneration,
	restartConsumeOperation,
	type TConsumeOperationEntry,
} from './consume-operation-state';
import { getConsumeRetryDelayMs } from './consume-retry-policy';
import {
	createExistingProducersSweeper,
	type TExistingProducersSweeper,
	type TExistingProducersSweepRequest,
} from './existing-producers-sweep';
import { isExternalTrackPresent, type TExternalStreamTrackPresence } from './use-pending-streams';

// How long to wait for an ICE "disconnected" state to recover before closing
// the transport. ICE disconnected can be transient (brief packet loss / route
// change); only "failed" is terminal per the spec.
const ICE_DISCONNECT_GRACE_MS = 30_000;

// getProducers is a trivial read (returns producer id lists, no media
// negotiation), so a healthy server answers in well under a second. Bound it
// with a tighter timeout than the generic consume RPC so a stalled sweep fails
// fast and leaves the rest of the recovery budget for the actual consumes.
const EXISTING_PRODUCERS_RPC_TIMEOUT_MS = 4_000;

type TConsumeAttemptResult = 'success' | 'failure';

type TConsumeOptions = {
	isManualRetry?: boolean;
	restartExisting?: boolean;
};

type TServerConsumerCleanupTarget = {
	remoteId: number;
	kind: StreamKind;
	consumerId: string;
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
	clearAllPendingStreams: (opts?: { preserveIntent?: boolean }) => void;
	reconcilePendingStreams: (producers: TRemoteProducerIds, externalStreamTracks?: TExternalStreamTrackPresence) => void;
	markWatchStopped: (remoteId: number, kind: StreamKind) => void;
	markConsumeStarted: (
		remoteId: number,
		kind: StreamKind,
		producerId?: string,
		consumeGeneration?: number,
		isManualRetry?: boolean,
	) => void;
	markConsumeSucceeded: (
		remoteId: number,
		kind: StreamKind,
		producerId: string,
		consumerId: string,
		consumeGeneration?: number,
	) => void;
	markConsumeFailed: (remoteId: number, kind: StreamKind, reason?: string, consumeGeneration?: number) => void;
	markConsumerClosed: (remoteId: number, kind: StreamKind, consumerId?: string) => void;
	onTransportFailure: () => void;
};

const useTransports = ({
	addRemoteUserStream,
	removeRemoteUserStream,
	addExternalStreamTrack,
	removeExternalStreamTrack,
	addPendingStream,
	clearAllPendingStreams,
	reconcilePendingStreams,
	markWatchStopped,
	markConsumeStarted,
	markConsumeSucceeded,
	markConsumeFailed,
	markConsumerClosed,
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
	const runConsumeExistingProducersSweepRef = useRef<
		((request: TExistingProducersSweepRequest) => Promise<void>) | undefined
	>(undefined);
	const existingProducersSweeperRef = useRef<TExistingProducersSweeper | undefined>(undefined);

	if (existingProducersSweeperRef.current === undefined) {
		existingProducersSweeperRef.current = createExistingProducersSweeper(
			(request) => runConsumeExistingProducersSweepRef.current!(request),
			(message) => logVoice(message),
		);
	}

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
		async (device: Device, prefetchedParams?: TTransportParams, isCurrent?: () => boolean) => {
			logVoice('Creating producer transport', {
				device,
				prefetched: !!prefetchedParams,
			});

			const trpc = getTRPCClient();

			try {
				const params = prefetchedParams ?? (await trpc.voice.createProducerTransport.mutate());

				if (isCurrent && !isCurrent()) {
					throw new Error('Producer transport creation superseded');
				}

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
		async (device: Device, prefetchedParams?: TTransportParams, isCurrent?: () => boolean) => {
			logVoice('Creating consumer transport', {
				device,
				prefetched: !!prefetchedParams,
			});

			const trpc = getTRPCClient();

			try {
				const params = prefetchedParams ?? (await trpc.voice.createConsumerTransport.mutate());

				if (isCurrent && !isCurrent()) {
					throw new Error('Consumer transport creation superseded');
				}

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
		async (
			remoteId: number,
			kind: StreamKind,
			rtpCapabilities: RtpCapabilities,
			operationKey: string,
			operation: TConsumeOperationEntry,
		): Promise<TConsumeAttemptResult> => {
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

				if (!isCurrentConsumeOperation(consumeOperationState.current, operationKey, operation)) {
					logVoice('Consume operation superseded before local consumer creation', {
						remoteId,
						kind,
					});
					await closeServerConsumerAfterFailedConsume(
						serverConsumerCleanupTarget,
						'consume operation superseded before local consumer creation',
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

				if (!isCurrentConsumeOperation(consumeOperationState.current, operationKey, operation)) {
					logVoice('Consume operation superseded before local stream attach', {
						remoteId,
						kind,
					});
					newConsumer.close();
					await closeServerConsumerAfterFailedConsume(
						serverConsumerCleanupTarget,
						'consume operation superseded before local stream attach',
					);
					return 'failure';
				}

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

						// Tell the ledger the consumer is gone so a 'consumed' slot cannot
						// strand: without this, the slot stays consumed with no card, no
						// derived pending entry, and no repair path.
						markConsumerClosed(remoteId, kind, newConsumer.id);
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

				if (!isCurrentConsumeOperation(consumeOperationState.current, operationKey, operation)) {
					logVoice('Consume operation superseded before success commit', {
						remoteId,
						kind,
					});
					newConsumer.close();
					await closeServerConsumerAfterFailedConsume(
						serverConsumerCleanupTarget,
						'consume operation superseded before success commit',
					);
					return 'failure';
				}

				serverConsumerCleanupTarget = undefined;
				markConsumeSucceeded(remoteId, kind, producerId, consumerId, operation.token);
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
			markConsumeSucceeded,
			markConsumerClosed,
			closeServerConsumerAfterFailedConsume,
		],
	);

	const consume = useCallback(
		async (
			remoteId: number,
			kind: StreamKind,
			rtpCapabilities: RtpCapabilities,
			expectedProducerId?: string,
			options: TConsumeOptions = {},
		) => {
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
					const operation = options.restartExisting
						? restartConsumeOperation(consumeOperationState.current, operationKey)
						: reserveConsumeOperation(consumeOperationState.current, operationKey);

					if (operation === undefined) {
						logVoice('Consume operation already in progress', {
							remoteId,
							kind,
						});
						return;
					}

					let failedAttemptIndex = 0;

					markConsumeStarted(remoteId, kind, expectedProducerId, operation.token, options.isManualRetry === true);

					try {
						while (isCurrentConsumeOperation(consumeOperationState.current, operationKey, operation)) {
							const result = await consumeOnce(remoteId, kind, rtpCapabilities, operationKey, operation);

							if (result === 'success') {
								return;
							}

							if (!isCurrentConsumeOperation(consumeOperationState.current, operationKey, operation)) {
								break;
							}

							const retryDelayMs = getConsumeRetryDelayMs(kind, failedAttemptIndex);

							if (retryDelayMs === undefined) {
								logVoice('Remote consume failed without retry', {
									remoteId,
									kind,
									failedAttempts: failedAttemptIndex + 1,
								});
								markConsumeFailed(remoteId, kind, 'consume retry exhausted', operation.token);
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
		[consumeOnce, markConsumeFailed, markConsumeStarted],
	);

	const runConsumeExistingProducersSweep = useCallback(
		async ({ rtpCapabilities, externalStreamTracks, prefetchedProducers }: TExistingProducersSweepRequest) => {
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

					// Stamp the sweep with the consume generation at entry.
					// cleanupTransports() bumps this generation (via
					// resetConsumeOperationGeneration) on teardown/reconnect, so a sweep
					// whose awaits straddle a cleanup can detect that its producer snapshot
					// is stale and bail before mutating the rebuilt ledger. Without this a
					// stale reconcile can mark a live new-session producer absent
					// (producerPresent: false); that slot then drops out of pendingStreams,
					// so the repair runner never reschedules it and the bad state sticks —
					// silent remote audio loss / a stuck failed video card.
					const sweepGeneration = consumeOperationState.current.generation;
					const isSweepSuperseded = () => consumeOperationState.current.generation !== sweepGeneration;

					const trpc = getTRPCClient();

					try {
						const producers =
							prefetchedProducers ??
							(await withConsumeAttemptTimeout(trpc.voice.getProducers.query(), EXISTING_PRODUCERS_RPC_TIMEOUT_MS));
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

						// A cleanup/reconnect landed while the snapshot was in flight — the
						// transports and ledger this snapshot describes are gone. Applying it
						// now would consume against dead transports and poison the rebuilt
						// ledger, so discard it and let the post-cleanup sweep own the state.
						if (isSweepSuperseded()) {
							logVoice('Discarding existing-producer sweep from a superseded transport generation');
							return;
						}

						await Promise.all(remoteAudioIds.map((remoteId) => consume(remoteId, StreamKind.AUDIO, rtpCapabilities)));

						// Re-check after the consume await: a cleanup may have landed while
						// audio was being consumed, and the pending/reconcile tail below writes
						// straight to the shared ledger with no per-op generation guard.
						if (isSweepSuperseded()) {
							logVoice('Discarding existing-producer sweep tail from a superseded transport generation');
							return;
						}

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

							if (isExternalTrackPresent(tracks, 'audio')) {
								addPendingStream(streamId, StreamKind.EXTERNAL_AUDIO);
							}
							if (isExternalTrackPresent(tracks, 'video')) {
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

	runConsumeExistingProducersSweepRef.current = runConsumeExistingProducersSweep;

	const consumeExistingProducers = useCallback(
		(
			rtpCapabilities: RtpCapabilities,
			externalStreamTracks?: TExternalStreamTrackPresence,
			prefetchedProducers?: TRemoteProducerIds,
		) =>
			existingProducersSweeperRef.current!.schedule({
				rtpCapabilities,
				externalStreamTracks,
				prefetchedProducers,
			}),
		[],
	);

	const closeConsumer = useCallback(async (remoteId: number, kind: StreamKind, consumerId?: string) => {
		const existingConsumer = consumers.current[remoteId]?.[kind];
		const existingConsumerId = existingConsumer?.id;
		const targetConsumerId = consumerId ?? existingConsumerId;

		if (
			existingConsumer &&
			!existingConsumer.closed &&
			(consumerId === undefined || existingConsumerId === consumerId)
		) {
			existingConsumer.close();
		}

		try {
			const trpc = getTRPCClient();

			await trpc.voice.closeConsumer.mutate({
				remoteId,
				kind,
				consumerId: targetConsumerId,
			});
		} catch (error) {
			logVoice('Error closing remote consumer', {
				error,
				remoteId,
				kind,
				consumerId: targetConsumerId,
			});
		}
	}, []);

	const stopWatchingStream = useCallback(
		async (remoteId: number, kind: StreamKind) => {
			if (kind === StreamKind.AUDIO) {
				logVoice('Ignoring stop-watch request for audio stream', {
					remoteId,
					kind,
				});
				return;
			}

			markWatchStopped(remoteId, kind);
		},
		[markWatchStopped],
	);

	const cleanupTransports = useCallback(
		(opts?: { preserveRemoteMediaIntent?: boolean }) => {
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
			// Drop any in-flight/queued existing-producer sweep so a stalled sweep
			// (e.g. a hung getProducers during reconnect) cannot poison the
			// single-flight state for the rebuilt transport generation.
			existingProducersSweeperRef.current?.reset();
			clearAllPendingStreams({ preserveIntent: opts?.preserveRemoteMediaIntent === true });

			if (producerTransport.current && !producerTransport.current.closed) {
				producerTransport.current.close();
			}

			producerTransport.current = undefined;

			if (consumerTransport.current && !consumerTransport.current.closed) {
				consumerTransport.current.close();
			}

			consumerTransport.current = undefined;

			logVoice('Transports cleanup complete');
		},
		[clearAllPendingStreams],
	);

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
		closeConsumer,
		stopWatchingStream,
		cleanupTransports,
		getActiveConsumerProducerId,
	};
};

export { useTransports };
