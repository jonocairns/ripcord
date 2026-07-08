import { StreamKind, type TExternalStream, type TRemoteProducerIds } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useEffect } from 'react';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import type { TRemoteMediaSubscriptions } from './remote-media-subscriptions';
import {
	getOldestRepairEligiblePendingCreatedAt,
	getPendingStreamKey,
	PENDING_STREAM_REPAIR_AGE_MS,
	type TExternalStreamTrackPresence,
	type TPendingStream,
} from './use-pending-streams';

// Screen-audio watch intent lives on the ledger (SCREEN_AUDIO.desired, coupled
// to the screen's desire), so repair reads it here instead of the removed
// watchedScreenAudioRef. See remote-media-subscriptions inheritsScreenAudioDesire.
const isScreenAudioDesiredInLedger = (subscriptions: TRemoteMediaSubscriptions, remoteId: number): boolean =>
	subscriptions.get(getPendingStreamKey(remoteId, StreamKind.SCREEN_AUDIO))?.desired === true;

// External watch intent lives on the ledger (EXTERNAL_AUDIO/VIDEO.desired, keyed
// by streamId), so the repair pass reads it here instead of the removed
// watchedExternalStreamsRef. streamId keying matches the reconnect capture
// (captureWatchedRemoteStreams), which already derives external intent this way.
const isExternalStreamDesiredInLedger = (
	subscriptions: TRemoteMediaSubscriptions,
	streamId: number,
	kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO,
): boolean => subscriptions.get(getPendingStreamKey(streamId, kind))?.desired === true;

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

		const oldestRepairEligibleCreatedAt = getOldestRepairEligiblePendingCreatedAt(
			pendingStreams,
			(streamId, kind) => {
				if (!currentChannelExternalStreams[streamId]) {
					return false;
				}

				return isExternalStreamDesiredInLedger(remoteMediaSubscriptionsRef.current, streamId, kind);
			},
			(remoteId) => isScreenAudioDesiredInLedger(remoteMediaSubscriptionsRef.current, remoteId),
		);

		if (oldestRepairEligibleCreatedAt === undefined) {
			return;
		}

		const scheduledVoiceChannelId = currentVoiceChannelId;
		const repairDelayMs = Math.max(0, oldestRepairEligibleCreatedAt + PENDING_STREAM_REPAIR_AGE_MS - Date.now());
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
