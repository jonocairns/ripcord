import { StreamKind } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useEffect } from 'react';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { useVoiceReconnectStore } from '@/features/server/voice/reconnect-coordinator';
import { logVoice } from '@/helpers/browser-logger';
import { getTRPCClient } from '@/lib/trpc';
import type { TRemoteUserStreamKinds } from '@/types';
import { shouldSyncExistingProducersAfterVoiceEventSubscriptionStart } from './voice-event-sync-policy';
import { shouldIgnoreProducerClosedEvent } from './voice-producer-event-identity';

const VOICE_EVENT_PRODUCER_SYNC_DEBOUNCE_MS = 500;

type TEvents = {
	consume: (remoteId: number, kind: StreamKind, rtpCapabilities: RtpCapabilities, producerId?: string) => Promise<void>;
	syncExistingProducers: (rtpCapabilities: RtpCapabilities) => Promise<void>;
	addPendingStream: (remoteId: number, kind: StreamKind, producerId?: string) => void;
	removePendingStream: (remoteId: number, kind: StreamKind, producerId?: string) => void;
	removeRemoteUserStream: (userId: number, kind: TRemoteUserStreamKinds) => void;
	removeExternalStreamTrack: (streamId: number, kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO) => void;
	removeExternalStream: (streamId: number) => void;
	clearRemoteUserStreamsForUser: (userId: number) => void;
	clearPendingStreamsForUser: (userId: number) => void;
	onVoiceActivityUpdate: (activity: { userId: number; isSpeaking: boolean }) => void;
	onTransportFailure: () => void;
	getActiveConsumerProducerId: (remoteId: number, kind: StreamKind) => string | undefined;
	getPendingStreamProducerId: (remoteId: number, kind: StreamKind) => string | undefined;
	rtpCapabilities: RtpCapabilities | null;
	reconnectNonce: number;
};

const useVoiceEvents = ({
	consume,
	syncExistingProducers,
	addPendingStream,
	removePendingStream,
	removeRemoteUserStream,
	removeExternalStreamTrack,
	removeExternalStream,
	clearRemoteUserStreamsForUser,
	clearPendingStreamsForUser,
	onVoiceActivityUpdate,
	onTransportFailure,
	getActiveConsumerProducerId,
	getPendingStreamProducerId,
	rtpCapabilities,
	reconnectNonce,
}: TEvents) => {
	const currentVoiceChannelId = useCurrentVoiceChannelId();
	const ownUserId = useOwnUserId();
	const reconnectingSince = useVoiceReconnectStore((state) => state.reconnectingSince);
	const reconnectAuthenticated = useVoiceReconnectStore((state) => state.reconnectAuthenticated);

	useEffect(() => {
		// Force a fresh subscription set after WS reconnect even when the voice
		// channel id itself did not change.
		void reconnectNonce;

		if (currentVoiceChannelId === undefined) {
			return;
		}

		// These are protected subscriptions. A reconnected socket starts
		// unauthenticated (server createContext sets authenticated: false) until
		// joinServer re-auths it, so subscribing during that gap just rejects every
		// stream with UNAUTHORIZED and forces a teardown + rebuild. Wait for the
		// auth gate. In steady state reconnectingSince is undefined, so this never
		// blocks the normal subscription path.
		if (reconnectingSince !== undefined && !reconnectAuthenticated) {
			logVoice('Deferring voice event subscriptions until the reconnected WS re-authenticates', {
				channelId: currentVoiceChannelId,
			});
			return;
		}

		const trpc = getTRPCClient();

		let isCleaningUp = false;
		let producerRepairSyncTimeout: ReturnType<typeof setTimeout> | undefined;

		const scheduleProducerRepairSync = (source: string, error: unknown): void => {
			logVoice(`${source} subscription error`, { error });

			if (!rtpCapabilities) {
				logVoice('Skipping producer repair sync after subscription error - missing RTP capabilities', {
					source,
				});
				return;
			}

			if (producerRepairSyncTimeout !== undefined) {
				return;
			}

			producerRepairSyncTimeout = setTimeout(() => {
				producerRepairSyncTimeout = undefined;

				if (isCleaningUp) {
					return;
				}

				logVoice('Repairing producer state after voice event subscription error', {
					source,
					channelId: currentVoiceChannelId,
				});

				void syncExistingProducers(rtpCapabilities).catch((syncError) => {
					if (isCleaningUp) {
						return;
					}

					logVoice('Failed to repair producer state after voice event subscription error', {
						error: syncError,
						source,
						channelId: currentVoiceChannelId,
					});
				});
			}, VOICE_EVENT_PRODUCER_SYNC_DEBOUNCE_MS);
		};

		const onVoiceNewProducerSub = trpc.voice.onNewProducer.subscribe(undefined, {
			onData: ({ remoteId, kind, channelId, producerId }) => {
				if (currentVoiceChannelId !== channelId || isCleaningUp) return;

				if (remoteId === ownUserId) {
					logVoice('Ignoring own producer event', {
						remoteId,
						ownUserId,
						kind,
						channelId,
					});

					return;
				}

				logVoice('New producer event received', {
					remoteId,
					kind,
					channelId,
					producerId,
				});

				if (kind === StreamKind.AUDIO) {
					if (!rtpCapabilities) {
						logVoice('Skipping audio consume - missing RTP capabilities', {
							remoteId,
							kind,
							channelId,
						});
						return;
					}

					void consume(remoteId, kind, rtpCapabilities, producerId);
					return;
				}

				addPendingStream(remoteId, kind, producerId);
			},
			onError: (error) => {
				scheduleProducerRepairSync('onVoiceNewProducer', error);
			},
		});

		const onVoiceProducerClosedSub = trpc.voice.onProducerClosed.subscribe(undefined, {
			onData: ({ channelId, remoteId, kind, producerId }) => {
				if (currentVoiceChannelId !== channelId || isCleaningUp) return;

				if (
					shouldIgnoreProducerClosedEvent({
						eventProducerId: producerId,
						activeConsumerProducerId: getActiveConsumerProducerId(remoteId, kind),
						pendingProducerId: getPendingStreamProducerId(remoteId, kind),
					})
				) {
					logVoice('Ignoring stale producer closed event', {
						remoteId,
						kind,
						channelId,
						producerId,
					});
					return;
				}

				logVoice('Producer closed event received', {
					remoteId,
					kind,
					channelId,
					producerId,
				});

				try {
					// A SCREEN close revokes SCREEN_AUDIO desire inside the reducer
					// (markRemoteProducerClosed cascade), so audio intent cannot outlive
					// the share while SCREEN_AUDIO producer churn alone still keeps it.
					removePendingStream(remoteId, kind, producerId);

					if (kind === StreamKind.EXTERNAL_VIDEO || kind === StreamKind.EXTERNAL_AUDIO) {
						removeExternalStreamTrack(remoteId, kind);
					} else {
						removeRemoteUserStream(remoteId, kind);
					}
				} catch (error) {
					logVoice('Error removing remote stream for closed producer', {
						error,
						remoteId,
						kind,
						channelId,
					});
				}
			},
			onError: (error) => {
				scheduleProducerRepairSync('onVoiceProducerClosed', error);
			},
		});

		const onVoiceUserLeaveSub = trpc.voice.onLeave.subscribe(undefined, {
			onData: ({ channelId, userId }) => {
				if (currentVoiceChannelId !== channelId || isCleaningUp) return;

				logVoice('User leave event received', { userId, channelId });

				try {
					clearPendingStreamsForUser(userId);
					clearRemoteUserStreamsForUser(userId);
				} catch (error) {
					logVoice('Error clearing remote streams for user', { error });
				}
			},
			onError: (error) => {
				logVoice('onVoiceUserLeave subscription error', { error });
			},
		});

		const onVoiceRemoveExternalStreamSub = trpc.voice.onRemoveExternalStream.subscribe(undefined, {
			onData: ({ channelId, streamId }) => {
				if (currentVoiceChannelId !== channelId || isCleaningUp) return;

				logVoice('External stream removed event received', {
					streamId,
					channelId,
				});

				try {
					removePendingStream(streamId, StreamKind.EXTERNAL_AUDIO);
					removePendingStream(streamId, StreamKind.EXTERNAL_VIDEO);
					removeExternalStream(streamId);
				} catch (error) {
					logVoice('Error removing external stream', {
						error,
						streamId,
						channelId,
					});
				}
			},
			onError: (error) => {
				logVoice('onVoiceRemoveExternalStream subscription error', { error });
			},
		});

		const onVoiceTransportFailedSub = trpc.voice.onTransportFailed.subscribe(undefined, {
			onData: () => {
				if (isCleaningUp) return;

				logVoice('Server-side transport failure event received, triggering recovery');
				onTransportFailure();
			},
			onError: (error) => {
				logVoice('onVoiceTransportFailed subscription error', { error });
			},
		});

		const onVoiceActivityUpdateSub = trpc.voice.onActivityUpdate.subscribe(undefined, {
			onData: ({ channelId, userId, isSpeaking }) => {
				if (currentVoiceChannelId !== channelId || isCleaningUp) return;

				onVoiceActivityUpdate({ userId, isSpeaking });
			},
			onError: (error) => {
				logVoice('onVoiceActivityUpdate subscription error', { error });
			},
		});

		if (rtpCapabilities && shouldSyncExistingProducersAfterVoiceEventSubscriptionStart(reconnectingSince)) {
			logVoice('Syncing existing producers after voice event subscription start', {
				channelId: currentVoiceChannelId,
			});

			void syncExistingProducers(rtpCapabilities).catch((error) => {
				if (isCleaningUp) {
					return;
				}

				logVoice('Failed to sync existing producers after voice event subscription start', {
					error,
					channelId: currentVoiceChannelId,
				});
			});
		}

		if (rtpCapabilities && !shouldSyncExistingProducersAfterVoiceEventSubscriptionStart(reconnectingSince)) {
			logVoice('Skipping producer sync after voice event subscription start during reconnect recovery', {
				channelId: currentVoiceChannelId,
			});
		}

		return () => {
			logVoice('Cleaning up voice events');

			isCleaningUp = true;

			if (producerRepairSyncTimeout !== undefined) {
				clearTimeout(producerRepairSyncTimeout);
				producerRepairSyncTimeout = undefined;
			}

			onVoiceNewProducerSub.unsubscribe();
			onVoiceProducerClosedSub.unsubscribe();
			onVoiceUserLeaveSub.unsubscribe();
			onVoiceRemoveExternalStreamSub.unsubscribe();
			onVoiceTransportFailedSub.unsubscribe();
			onVoiceActivityUpdateSub.unsubscribe();
		};
	}, [
		currentVoiceChannelId,
		ownUserId,
		consume,
		syncExistingProducers,
		addPendingStream,
		removePendingStream,
		removeRemoteUserStream,
		removeExternalStreamTrack,
		removeExternalStream,
		clearRemoteUserStreamsForUser,
		clearPendingStreamsForUser,
		onVoiceActivityUpdate,
		onTransportFailure,
		getActiveConsumerProducerId,
		getPendingStreamProducerId,
		rtpCapabilities,
		reconnectingSince,
		reconnectAuthenticated,
		reconnectNonce,
	]);
};

export { useVoiceEvents };
