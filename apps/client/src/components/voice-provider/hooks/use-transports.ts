import {
	getMediasoupKind,
	StreamKind,
	type TRemoteProducerIds,
	type TTransportParams,
	type TVoiceTransportFailureEvent,
} from '@sharkord/shared';
import { TRPCClientError } from '@trpc/client';
import type { AppData, Consumer, Device, RtpCapabilities, RtpParameters, Transport } from 'mediasoup-client/types';
import { useCallback, useRef } from 'react';
import { logVoice, traceSentrySpan } from '@/helpers/browser-logger';
import { getTRPCClient } from '@/lib/trpc';
import type { TRemoteUserStreamKinds } from '@/types';
import { shouldHandleVoiceTransportFailure } from '../voice-transport-failure-identity';
import { withConsumeAttemptTimeout } from './consume-attempt-timeout';
import {
	createExistingProducersSweeper,
	type TExistingProducersSweeper,
	type TExistingProducersSweepRequest,
} from './existing-producers-sweep';
import {
	createRemoteMediaConsumeController,
	type TRemoteMediaConsumeController,
} from './remote-media-consume-controller';
import { runRemoteMediaProducerRepair } from './remote-media-producer-repair';
import type { TRemoteMediaRepairIdentity } from './remote-media-subscriptions';
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

type TConsumeOptions = {
	isManualRetry?: boolean;
	restartExisting?: boolean;
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
	addPendingStream: (
		remoteId: number,
		kind: StreamKind,
		producerId?: string,
		externalStreamTracks?: TExternalStreamTrackPresence,
	) => void;
	removePendingStream: (
		remoteId: number,
		kind: StreamKind,
		producerId?: string,
		options?: { preserveDesired?: boolean },
	) => void;
	clearAllPendingStreams: (opts?: { preserveIntent?: boolean }) => void;
	reconcilePendingStreams: (producers: TRemoteProducerIds, externalStreamTracks?: TExternalStreamTrackPresence) => void;
	markWatchStopped: (remoteId: number, kind: StreamKind) => void;
	markConsumeStarted: (
		remoteId: number,
		kind: StreamKind,
		producerId: string | undefined,
		consumeGeneration: number,
		isManualRetry: boolean,
		signal: AbortSignal,
	) => Promise<boolean>;
	markConsumeSucceeded: (
		remoteId: number,
		kind: StreamKind,
		producerId: string,
		consumerId: string,
		consumeGeneration?: number,
	) => void;
	markConsumeFailed: (remoteId: number, kind: StreamKind, reason?: string, consumeGeneration?: number) => void;
	markConsumerClosed: (remoteId: number, kind: StreamKind, consumerId?: string) => void;
	isProducerCurrent: (remoteId: number, kind: StreamKind, producerId: string) => boolean;
	isRepairIdentityCurrent: (identity: TRemoteMediaRepairIdentity) => boolean;
	onTransportFailure: (failure?: TVoiceTransportFailureEvent) => void;
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
	markWatchStopped,
	markConsumeStarted,
	markConsumeSucceeded,
	markConsumeFailed,
	markConsumerClosed,
	isProducerCurrent,
	isRepairIdentityCurrent,
	onTransportFailure,
}: TUseTransportParams) => {
	const producerTransport = useRef<Transport<AppData> | undefined>(undefined);
	const consumerTransport = useRef<Transport<AppData> | undefined>(undefined);
	const producerDisconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const consumerDisconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const consumeControllerRef = useRef<
		TRemoteMediaConsumeController<Transport<AppData>, Consumer<AppData>, RtpCapabilities, RtpParameters> | undefined
	>(undefined);
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

	if (consumeControllerRef.current === undefined) {
		consumeControllerRef.current = createRemoteMediaConsumeController<
			Transport<AppData>,
			Consumer<AppData>,
			RtpCapabilities,
			RtpParameters
		>({
			delay: (milliseconds, signal) =>
				new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => {
						signal.removeEventListener('abort', abort);
						resolve();
					}, milliseconds);
					const abort = () => {
						clearTimeout(timeout);
						reject(new Error('Remote media consume delay aborted'));
					};

					if (signal.aborted) {
						abort();
						return;
					}

					signal.addEventListener('abort', abort, { once: true });
				}),
			getTransportId: (transport) => transport.id,
			isTransportClosed: (transport) => transport.closed,
			consumeOnServer: (request, transportId) =>
				getTRPCClient().voice.consume.mutate({
					kind: request.kind,
					remoteId: request.remoteId,
					rtpCapabilities: request.rtpCapabilities,
					paused: true,
					transportId,
				}),
			resumeServerConsumer: (target) => getTRPCClient().voice.resumeConsumer.mutate(target),
			closeServerConsumer: (target) => getTRPCClient().voice.closeConsumer.mutate(target),
			createLocalConsumer: (transport, allocation) =>
				transport.consume({
					id: allocation.consumerId,
					producerId: allocation.producerId,
					kind: getMediasoupKind(allocation.consumerKind),
					rtpParameters: allocation.consumerRtpParameters,
					streamId: allocation.consumerRtpParameters.rtcp?.cname,
				}),
			closeLocalConsumer: (consumer) => consumer.close(),
			isLocalConsumerClosed: (consumer) => consumer.closed,
			observeLocalConsumerClosed: (consumer, onClosed) => {
				['transportclose', 'trackended', '@close', 'close'].forEach((event) => {
					// @ts-expect-error mediasoup's internal close events are not in the public event map.
					consumer.on(event, onClosed);
				});
			},
			attachLocalConsumer: ({ remoteId, kind }, consumer) => {
				const stream = new MediaStream();
				stream.addTrack(consumer.track);

				if (kind === StreamKind.EXTERNAL_VIDEO || kind === StreamKind.EXTERNAL_AUDIO) {
					addExternalStreamTrack(remoteId, stream, kind);
					return () => removeExternalStreamTrack(remoteId, kind);
				}

				addRemoteUserStream(remoteId, stream, kind);
				return () => removeRemoteUserStream(remoteId, kind);
			},
			isProducerCurrent,
			onConsumeStarted: (request, operationToken, signal) =>
				markConsumeStarted(
					request.remoteId,
					request.kind,
					request.expectedProducerId,
					operationToken,
					request.isManualRetry === true,
					signal,
				),
			onConsumeSucceeded: (request, result) => {
				markConsumeSucceeded(
					request.remoteId,
					request.kind,
					result.producerId,
					result.consumerId,
					result.operationToken,
				);
			},
			onConsumeFailed: (request, result) => {
				markConsumeFailed(request.remoteId, request.kind, result.reason, result.operationToken);
			},
			onConsumerClosed: markConsumerClosed,
			log: (message, context) => logVoice(message, context),
			trace: (request, operation) =>
				traceSentrySpan(
					{
						name: 'voice.consume',
						op: 'voice.consume',
						attributes: {
							'voice.remote_id': request.remoteId,
							'voice.stream_kind': request.kind,
						},
					},
					operation,
				),
		});
	}

	const consumeController = consumeControllerRef.current;

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
						if (producerTransport.current !== transport || transport.closed) {
							throw new Error('Producer transport connect superseded');
						}
						await trpc.voice.connectProducerTransport.mutate({
							dtlsParameters,
							transportId: transport.id,
						});
						if (producerTransport.current !== transport || transport.closed) {
							throw new Error('Producer transport connect superseded');
						}

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
								const { iceParameters } = await getTRPCClient().voice.restartProducerIce.mutate({
									transportId: transport.id,
								});
								if (
									producerTransport.current === transport &&
									transport.connectionState !== 'connected' &&
									!transport.closed
								) {
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

					if (producerTransport.current !== transport || transport.closed) {
						errback(new Error('Producer transport not available'));
						return;
					}

					try {
						const producerId = await trpc.voice.produce.mutate({
							transportId: transport.id,
							kind,
							rtpParameters,
						});

						if (producerTransport.current !== transport || transport.closed) {
							throw new Error('Producer transport produce superseded');
						}
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
				consumeController.replaceTransport(transport);
				consumerTransport.current = transport;

				transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
					logVoice('Consumer transport connected', { dtlsParameters });

					try {
						if (consumerTransport.current !== transport || transport.closed) {
							throw new Error('Consumer transport connect superseded');
						}
						await trpc.voice.connectConsumerTransport.mutate({
							dtlsParameters,
							transportId: transport.id,
						});
						if (consumerTransport.current !== transport || transport.closed) {
							throw new Error('Consumer transport connect superseded');
						}

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

					consumerTransport.current = undefined;
					consumeController.invalidateTransport();
					clearAllPendingStreams();

					if (!transport.closed) {
						transport.close();
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
								const { iceParameters } = await getTRPCClient().voice.restartConsumerIce.mutate({
									transportId: transport.id,
								});
								if (
									consumerTransport.current === transport &&
									transport.connectionState !== 'connected' &&
									!transport.closed
								) {
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
							consumeController.invalidateTransport();
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
		[clearAllPendingStreams, consumeController, onTransportFailure],
	);

	const consume = useCallback(
		(
			remoteId: number,
			kind: StreamKind,
			rtpCapabilities: RtpCapabilities,
			expectedProducerId?: string,
			options: TConsumeOptions = {},
		) =>
			consumeController.consume({
				remoteId,
				kind,
				rtpCapabilities,
				expectedProducerId,
				isManualRetry: options.isManualRetry,
				restartExisting: options.restartExisting,
			}),
		[consumeController],
	);

	const repairRemoteProducer = useCallback(
		(
			identity: TRemoteMediaRepairIdentity,
			rtpCapabilities: RtpCapabilities,
			externalStreamTracks?: TExternalStreamTrackPresence,
		) =>
			runRemoteMediaProducerRepair(identity, externalStreamTracks, {
				getProducers: () =>
					withConsumeAttemptTimeout(getTRPCClient().voice.getProducers.query(), EXISTING_PRODUCERS_RPC_TIMEOUT_MS),
				isIdentityCurrent: isRepairIdentityCurrent,
				markProducerMissing: (repairIdentity) => {
					removePendingStream(repairIdentity.remoteId, repairIdentity.kind, repairIdentity.producerId, {
						preserveDesired: true,
					});
				},
				markProducerPresent: (repairIdentity, producerId, currentExternalStreamTracks) => {
					addPendingStream(repairIdentity.remoteId, repairIdentity.kind, producerId, currentExternalStreamTracks);
				},
				consume: (repairIdentity) =>
					consume(repairIdentity.remoteId, repairIdentity.kind, rtpCapabilities, repairIdentity.producerId, {
						restartExisting: true,
					}),
			}),
		[addPendingStream, consume, isRepairIdentityCurrent, removePendingStream],
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

					// Stamp the sweep with the controller transport generation at entry.
					// cleanupTransports() bumps the controller's transport generation on
					// teardown/reconnect, so a sweep
					// whose awaits straddle a cleanup can detect that its producer snapshot
					// is stale and bail before mutating the rebuilt ledger. Without this a
					// stale reconcile can mark a live new-session producer absent
					// (producerPresent: false); that slot then drops out of pendingStreams,
					// so the repair runner never reschedules it and the bad state sticks —
					// silent remote audio loss / a stuck failed video card.
					const sweepGeneration = consumeController.getTransportGeneration();
					const isSweepSuperseded = () => consumeController.getTransportGeneration() !== sweepGeneration;

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
		[addPendingStream, consume, consumeController, reconcilePendingStreams],
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

	const closeConsumer = useCallback(
		(remoteId: number, kind: StreamKind, consumerId?: string) =>
			consumeController.closeConsumer(remoteId, kind, consumerId),
		[consumeController],
	);

	const isTransportFailureCurrent = useCallback(
		(failure: TVoiceTransportFailureEvent): boolean =>
			shouldHandleVoiceTransportFailure(failure, {
				producerTransportId: producerTransport.current?.id,
				consumerTransportId: consumerTransport.current?.id,
			}),
		[],
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

			// Invalidate any in-flight consume for this slot before the ledger write.
			// The ledger only rejects the stale success (it has no consumer to close
			// yet), so without this the running controller operation could still attach and
			// resume a live consumer that nothing owns. Controller cancellation
			// closes local state immediately and retains ownership of any late server
			// allocation. Screen audio rides along with the screen, mirroring the
			// markRemoteWatchStopped cascade.
			consumeController.cancel(remoteId, kind);

			markWatchStopped(remoteId, kind);
		},
		[consumeController, markWatchStopped],
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

			const consumerTransportToClose = consumerTransport.current;
			consumerTransport.current = undefined;
			consumeController.invalidateTransport();
			// Drop any in-flight/queued existing-producer sweep so a stalled sweep
			// (e.g. a hung getProducers during reconnect) cannot poison the
			// single-flight state for the rebuilt transport generation.
			existingProducersSweeperRef.current?.reset();
			clearAllPendingStreams({ preserveIntent: opts?.preserveRemoteMediaIntent === true });

			if (producerTransport.current && !producerTransport.current.closed) {
				producerTransport.current.close();
			}

			producerTransport.current = undefined;

			if (consumerTransportToClose && !consumerTransportToClose.closed) {
				consumerTransportToClose.close();
			}

			logVoice('Transports cleanup complete');
		},
		[clearAllPendingStreams, consumeController],
	);

	const getActiveConsumerProducerId = useCallback(
		(remoteId: number, kind: StreamKind): string | undefined =>
			consumeController.getActiveConsumerProducerId(remoteId, kind),
		[consumeController],
	);

	return {
		producerTransport,
		consumerTransport,
		createProducerTransport,
		createConsumerTransport,
		consume,
		repairRemoteProducer,
		consumeExistingProducers,
		closeConsumer,
		stopWatchingStream,
		cleanupTransports,
		getActiveConsumerProducerId,
		isTransportFailureCurrent,
	};
};

export { useTransports };
