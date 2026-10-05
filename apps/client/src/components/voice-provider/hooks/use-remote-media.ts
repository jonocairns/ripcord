import type { TExternalStream, TVoiceTransportFailureEvent } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useCallback, useEffect, useRef } from 'react';
import { useServerStore } from '@/features/server/slice';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { createRemoteMediaIntegration } from '../remote-media-integration';
import { useRemoteMediaSubscriptions } from './remote-media-subscriptions';
import type { TExternalStreamTrackPresence } from './use-pending-streams';
import { useRemoteMediaConsumeRunner } from './use-remote-media-consume-runner';
import { useRemoteMediaRepairRunner } from './use-remote-media-repair-runner';
import { useRemoteStreams } from './use-remote-streams';
import { useTransports } from './use-transports';
import { useVoiceEvents } from './use-voice-events';

type TChannelExternalStreams = Record<number, TExternalStream>;
const EMPTY_CHANNEL_EXTERNAL_STREAMS: TChannelExternalStreams = {};

type TUseRemoteMediaParams = {
	currentVoiceChannelId: number | undefined;
	rtpCapabilities: RtpCapabilities | null;
	reconnectNonce: number;
	getRtpCapabilities: () => RtpCapabilities | null;
	onTransportFailure: (failure?: TVoiceTransportFailureEvent) => void;
	onVoiceActivityUpdate: (activity: { userId: number; isSpeaking: boolean }) => void;
};

const useRemoteMedia = ({
	currentVoiceChannelId,
	rtpCapabilities,
	reconnectNonce,
	getRtpCapabilities,
	onTransportFailure,
	onVoiceActivityUpdate,
}: TUseRemoteMediaParams) => {
	const currentChannelExternalStreams = useServerStore<TChannelExternalStreams>((state) =>
		currentVoiceChannelId === undefined
			? EMPTY_CHANNEL_EXTERNAL_STREAMS
			: (state.externalStreamsMap[currentVoiceChannelId] ?? EMPTY_CHANNEL_EXTERNAL_STREAMS),
	);
	const {
		addExternalStreamTrack,
		removeExternalStreamTrack,
		removeExternalStream,
		clearExternalStreams,
		addRemoteUserStream,
		removeRemoteUserStream,
		clearRemoteUserStreamsForUser,
		clearRemoteUserStreams,
		externalStreams,
		remoteUserStreams,
	} = useRemoteStreams();
	const {
		remoteMediaSubscriptions,
		remoteMediaCommands,
		pendingStreams,
		visibleRemoteMedia,
		clearRemoteMediaCommands,
		addPendingStream,
		removePendingStream,
		clearPendingStreamsForUser,
		clearAllPendingStreams,
		reconcilePendingStreams,
		markRepairAttemptStarted,
		markWatchRequested,
		markWatchStopped,
		markRetryRequested,
		rehydrateWatchIntentOnly,
		markConsumeStarted,
		markConsumeSucceeded,
		markConsumeFailed,
		markConsumerClosed,
		clearExternalStream: clearRemoteMediaExternalStream,
	} = useRemoteMediaSubscriptions();

	const inputsRef = useLatestRef({
		currentVoiceChannelId,
		remoteMediaSubscriptions,
		pendingStreams,
		currentChannelExternalStreams,
		externalStreams,
		getRtpCapabilities,
		markConsumeStarted,
		markWatchRequested,
		markRetryRequested,
		addPendingStream,
		clearRemoteMediaExternalStream,
		removeExternalStream,
		log: logVoice,
	});
	const integrationRef = useRef<ReturnType<typeof createRemoteMediaIntegration> | undefined>(undefined);
	if (!integrationRef.current) integrationRef.current = createRemoteMediaIntegration(() => inputsRef.current);
	const integration = integrationRef.current;
	const {
		publishRemoteMediaConsumeStarted,
		isRemoteMediaProducerCurrent,
		isRemoteMediaRepairIdentityCurrent,
		getPendingStreamProducerId,
		captureWatchedRemoteStreams,
		removeExternalStreamAndSubscription,
		acceptStream,
		retryRemoteMedia,
	} = integration;
	useEffect(() => {
		integration.reconcileConsumeStarts(remoteMediaSubscriptions);
	}, [integration, remoteMediaSubscriptions]);

	const {
		producerTransport,
		consumerTransport,
		createProducerTransport,
		createConsumerTransport,
		consume,
		repairRemoteProducer,
		consumeExistingProducers,
		closeConsumer,
		cleanupTransports,
		getActiveConsumerProducerId,
		isTransportFailureCurrent,
		stopWatchingStream,
	} = useTransports({
		addExternalStreamTrack,
		removeExternalStreamTrack,
		addRemoteUserStream,
		removeRemoteUserStream,
		addPendingStream,
		removePendingStream,
		clearAllPendingStreams,
		reconcilePendingStreams,
		markWatchStopped,
		markConsumeStarted: publishRemoteMediaConsumeStarted,
		markConsumeSucceeded,
		markConsumeFailed,
		markConsumerClosed,
		isProducerCurrent: isRemoteMediaProducerCurrent,
		isRepairIdentityCurrent: isRemoteMediaRepairIdentityCurrent,
		onTransportFailure,
	});

	const getExternalStreamTrackPresence = useCallback((): TExternalStreamTrackPresence => {
		const tracks: TExternalStreamTrackPresence = {};

		Object.entries(currentChannelExternalStreams).forEach(([streamId, stream]) => {
			tracks[Number(streamId)] = stream.tracks;
		});

		return tracks;
	}, [currentChannelExternalStreams]);

	useRemoteMediaConsumeRunner({
		currentVoiceChannelId,
		rtpCapabilities,
		commands: remoteMediaCommands,
		remoteMediaSubscriptions,
		clearCommands: clearRemoteMediaCommands,
		consume,
		closeConsumer,
		getExternalStreamTrackPresence,
	});

	useEffect(() => {
		integration.reconcileExternalStreams({
			...inputsRef.current,
			currentChannelExternalStreams,
			externalStreams,
			pendingStreams,
			remoteMediaSubscriptions,
		});
	}, [integration, currentChannelExternalStreams, externalStreams, pendingStreams, remoteMediaSubscriptions]);

	useRemoteMediaRepairRunner({
		currentVoiceChannelId,
		rtpCapabilities,
		remoteMediaSubscriptions,
		pendingStreams,
		currentChannelExternalStreams,
		markRepairAttemptStarted,
		repairRemoteProducer,
		getExternalStreamTrackPresence,
	});

	const syncExistingProducers = useCallback(
		(rtpCapabilities: RtpCapabilities): Promise<void> =>
			consumeExistingProducers(rtpCapabilities, getExternalStreamTrackPresence()),
		[consumeExistingProducers, getExternalStreamTrackPresence],
	);

	useVoiceEvents({
		syncExistingProducers,
		addPendingStream,
		removePendingStream,
		removeRemoteUserStream,
		removeExternalStreamTrack,
		removeExternalStream: removeExternalStreamAndSubscription,
		clearRemoteUserStreamsForUser,
		clearPendingStreamsForUser,
		onVoiceActivityUpdate,
		onTransportFailure,
		isTransportFailureCurrent,
		getActiveConsumerProducerId,
		getPendingStreamProducerId,
		getExternalStreamTrackPresence,
		rtpCapabilities,
		reconnectNonce,
	});

	return {
		producerTransport,
		consumerTransport,
		createProducerTransport,
		createConsumerTransport,
		consumeExistingProducers,
		cleanupTransports,
		clearRemoteUserStreams,
		clearExternalStreams,
		captureWatchedRemoteStreams,
		rehydrateWatchIntentOnly,
		acceptStream,
		retryRemoteMedia,
		stopWatchingStream,
		remoteUserStreams,
		externalStreams,
		pendingStreams,
		remoteMediaSubscriptions,
		visibleRemoteMedia,
	};
};

export { useRemoteMedia };
