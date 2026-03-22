import { getMediasoupKind, StreamKind, type TRemoteProducerIds, type TTransportParams } from '@sharkord/shared';
import { TRPCClientError } from '@trpc/client';
import type { AppData, Consumer, Device, RtpCapabilities, Transport } from 'mediasoup-client/types';
import { useCallback, useRef } from 'react';
import { logVoice } from '@/helpers/browser-logger';
import { getTRPCClient } from '@/lib/trpc';
import type { TRemoteUserStreamKinds } from '@/types';

// How long to wait for an ICE "disconnected" state to recover before closing
// the transport. ICE disconnected can be transient (brief packet loss / route
// change); only "failed" is terminal per the spec.
const ICE_DISCONNECT_GRACE_MS = 5_000;

type TUseTransportParams = {
	addRemoteUserStream: (userId: number, stream: MediaStream, kind: TRemoteUserStreamKinds) => void;
	removeRemoteUserStream: (userId: number, kind: TRemoteUserStreamKinds) => void;
	addExternalStreamTrack: (
		streamId: number,
		stream: MediaStream,
		kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO,
	) => void;
	removeExternalStreamTrack: (streamId: number, kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO) => void;
	addPendingStream: (remoteId: number, kind: StreamKind) => void;
	removePendingStream: (remoteId: number, kind: StreamKind) => void;
	clearAllPendingStreams: () => void;
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
	const consumeOperationsInProgress = useRef<Set<string>>(new Set());

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
						logVoice('Producer transport disconnected, waiting for recovery...');
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

					if (!producerTransport.current) return;

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
						logVoice('Consumer transport disconnected, waiting for recovery...');
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
						}
					}
				});

				transport.on('icecandidateerror', (error) => {
					logVoice('Consumer transport ICE candidate error', { error });
				});
			} catch (error) {
				logVoice('Failed to create consumer transport', { error });
			}
		},
		[clearAllPendingStreams, onTransportFailure],
	);

	const consume = useCallback(
		async (remoteId: number, kind: StreamKind, rtpCapabilities: RtpCapabilities) => {
			if (!consumerTransport.current) {
				logVoice('Consumer transport not available');
				return;
			}

			const operationKey = `${remoteId}-${kind}`;

			if (consumeOperationsInProgress.current.has(operationKey)) {
				logVoice('Consume operation already in progress', {
					remoteId,
					kind,
				});
				return;
			}

			consumeOperationsInProgress.current.add(operationKey);

			try {
				logVoice('Consuming remote producer', { remoteId, kind });

				const trpc = getTRPCClient();

				const { producerId, consumerId, consumerKind, consumerRtpParameters } = await trpc.voice.consume.mutate({
					kind,
					remoteId,
					rtpCapabilities,
					paused: true,
				});

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

				const newConsumer = await consumerTransport.current.consume({
					id: consumerId,
					producerId: producerId,
					kind: getMediasoupKind(consumerKind),
					rtpParameters: consumerRtpParameters,
				});

				logVoice('Created new consumer', { newConsumer });

				const cleanupEvents = ['transportclose', 'trackended', '@close', 'close'];

				cleanupEvents.forEach((event) => {
					// @ts-expect-error - YOLO
					newConsumer?.on(event, () => {
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

				removePendingStream(remoteId, kind);

				try {
					await trpc.voice.resumeConsumer.mutate({
						remoteId,
						kind,
					});
				} catch (error) {
					logVoice('Error resuming remote consumer — closing stale consumer', {
						error,
						remoteId,
						kind,
					});

					newConsumer.close();
				}
			} catch (error) {
				logVoice('Error consuming remote producer', { error });
			} finally {
				consumeOperationsInProgress.current.delete(operationKey);
			}
		},
		[
			addRemoteUserStream,
			removeRemoteUserStream,
			addExternalStreamTrack,
			removeExternalStreamTrack,
			removePendingStream,
		],
	);

	const consumeExistingProducers = useCallback(
		async (
			rtpCapabilities: RtpCapabilities,
			externalStreamTracks?: {
				[streamId: number]: { audio?: boolean; video?: boolean };
			},
			prefetchedProducers?: TRemoteProducerIds,
		) => {
			logVoice('Consuming existing producers', {
				rtpCapabilities,
				prefetched: !!prefetchedProducers,
			});

			const trpc = getTRPCClient();

			try {
				const { remoteAudioIds, remoteScreenIds, remoteScreenAudioIds, remoteVideoIds, remoteExternalStreamIds } =
					prefetchedProducers ?? (await trpc.voice.getProducers.query());

				logVoice('Got existing producers', {
					remoteAudioIds,
					remoteScreenIds,
					remoteVideoIds,
					remoteExternalStreamIds,
				});

				remoteAudioIds.forEach((remoteId) => {
					consume(remoteId, StreamKind.AUDIO, rtpCapabilities);
				});

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
					const tracks = externalStreamTracks?.[streamId];

					if (tracks?.audio !== false) {
						addPendingStream(streamId, StreamKind.EXTERNAL_AUDIO);
					}
					if (tracks?.video !== false) {
						addPendingStream(streamId, StreamKind.EXTERNAL_VIDEO);
					}
				});
			} catch (error) {
				logVoice('Error consuming existing producers', { error });
			}
		},
		[addPendingStream, consume],
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

		consumeOperationsInProgress.current.clear();
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
	};
};

export { useTransports };
