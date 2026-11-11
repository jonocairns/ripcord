import type { TExternalStream, TVoiceTransportFailureEvent } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useServerStore } from '@/features/server/slice';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { createRemoteMediaIntegration, mountRemoteMediaIntegration } from './remote-media-integration';
import type { TExternalStreamTrackPresence } from './use-pending-streams';
import { useRemoteMediaConsumeRunner } from './use-remote-media-consume-runner';
import { useRemoteMediaRepairRunner } from './use-remote-media-repair-runner';
import { useRemoteMediaSubscriptions } from './use-remote-media-subscriptions';
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
	getScreenVideoElement: (remoteId: number) => HTMLVideoElement | null;
};

const useRemoteMedia = ({
	currentVoiceChannelId,
	rtpCapabilities,
	reconnectNonce,
	getRtpCapabilities,
	onTransportFailure,
	onVoiceActivityUpdate,
	getScreenVideoElement,
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
		ledgerStore,
		pendingStreams,
		visibleRemoteMedia,
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
		ledgerStore,
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
	useLayoutEffect(() => mountRemoteMediaIntegration(integration), [integration]);
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
		getScreenVideoElement,
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
		ledgerStore,
		consume,
		closeConsumer,
		getExternalStreamTrackPresence,
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: Ledger changes must still trigger external-stream reconciliation; integration reads the store at call time.
	useEffect(() => {
		integration.reconcileExternalStreams({
			...inputsRef.current,
			currentChannelExternalStreams,
			externalStreams,
		});
	}, [integration, currentChannelExternalStreams, externalStreams, pendingStreams, remoteMediaSubscriptions]);

	useRemoteMediaRepairRunner({
		currentVoiceChannelId,
		rtpCapabilities,
		ledgerStore,
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
