import type { TExternalStream, TRemoteProducerIds } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useEffect } from 'react';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import {
	remoteMediaSubscriptionsToRepairScheduleCommand,
	type TRemoteMediaSubscriptions,
} from './remote-media-subscriptions';
import type { TExternalStreamTrackPresence, TPendingStream } from './use-pending-streams';

type TConsumeExistingProducers = (
	rtpCapabilities: RtpCapabilities,
	externalStreamTracks?: TExternalStreamTrackPresence,
	prefetchedProducers?: TRemoteProducerIds,
) => Promise<unknown>;

type TUseRemoteMediaRepairRunnerInput = {
	currentVoiceChannelId: number | undefined;
	rtpCapabilities: RtpCapabilities | null;
	remoteMediaSubscriptions: TRemoteMediaSubscriptions;
	pendingStreams: Map<string, TPendingStream>;
	currentChannelExternalStreams: Record<number, TExternalStream>;
	refreshPendingStreamAges: () => void;
	consumeExistingProducers: TConsumeExistingProducers;
	getExternalStreamTrackPresence: () => TExternalStreamTrackPresence;
};

export const useRemoteMediaRepairRunner = ({
	currentVoiceChannelId,
	rtpCapabilities,
	remoteMediaSubscriptions,
	pendingStreams,
	currentChannelExternalStreams,
	refreshPendingStreamAges,
	consumeExistingProducers,
	getExternalStreamTrackPresence,
}: TUseRemoteMediaRepairRunnerInput) => {
	const remoteMediaSubscriptionsRef = useLatestRef(remoteMediaSubscriptions);
	const currentVoiceChannelIdRef = useLatestRef(currentVoiceChannelId);

	useEffect(() => {
		if (currentVoiceChannelId === undefined || !rtpCapabilities || pendingStreams.size === 0) {
			return;
		}

		const command = remoteMediaSubscriptionsToRepairScheduleCommand(
			remoteMediaSubscriptionsRef.current,
			pendingStreams,
			currentChannelExternalStreams,
		);

		if (command === undefined) {
			return;
		}

		const scheduledVoiceChannelId = currentVoiceChannelId;
		const repairDelayMs = Math.max(0, command.retryAt - Date.now());
		const repairTimeout = setTimeout(() => {
			if (currentVoiceChannelIdRef.current !== scheduledVoiceChannelId) {
				return;
			}

			logVoice('Repairing stale pending voice streams', {
				channelId: scheduledVoiceChannelId,
				pendingCount: pendingStreams.size,
			});

			// Reset every pending entry's age so the next repair pass is at least a
			// full repair age away, even if this sweep cannot clear an entry.
			refreshPendingStreamAges();

			void consumeExistingProducers(rtpCapabilities, getExternalStreamTrackPresence()).catch((error) => {
				logVoice('Failed to repair stale pending voice streams', {
					error,
					channelId: scheduledVoiceChannelId,
				});
			});
		}, repairDelayMs);

		return () => {
			clearTimeout(repairTimeout);
		};
	}, [
		consumeExistingProducers,
		currentChannelExternalStreams,
		currentVoiceChannelId,
		getExternalStreamTrackPresence,
		pendingStreams,
		refreshPendingStreamAges,
		rtpCapabilities,
	]);
};
