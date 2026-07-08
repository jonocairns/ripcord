import type { StreamKind } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useEffect, useMemo } from 'react';
import {
	remoteMediaSubscriptionsToStreamsToConsume,
	type TRemoteMediaSubscriptions,
} from './remote-media-subscriptions';
import type { TExternalStreamTrackPresence } from './use-pending-streams';

type TConsumeRemoteMedia = (
	remoteId: number,
	kind: StreamKind,
	rtpCapabilities: RtpCapabilities,
	expectedProducerId?: string,
) => Promise<unknown>;

type TUseRemoteMediaConsumeRunnerInput = {
	currentVoiceChannelId: number | undefined;
	rtpCapabilities: RtpCapabilities | null;
	remoteMediaSubscriptions: TRemoteMediaSubscriptions;
	getExternalStreamTrackPresence: () => TExternalStreamTrackPresence;
	consume: TConsumeRemoteMedia;
};

export const useRemoteMediaConsumeRunner = ({
	currentVoiceChannelId,
	rtpCapabilities,
	remoteMediaSubscriptions,
	getExternalStreamTrackPresence,
	consume,
}: TUseRemoteMediaConsumeRunnerInput) => {
	const streamsToConsume = useMemo(
		() => remoteMediaSubscriptionsToStreamsToConsume(remoteMediaSubscriptions, getExternalStreamTrackPresence()),
		[remoteMediaSubscriptions, getExternalStreamTrackPresence],
	);

	useEffect(() => {
		if (currentVoiceChannelId === undefined) {
			return;
		}

		const currentRtpCapabilities = rtpCapabilities;

		if (!currentRtpCapabilities) {
			return;
		}

		streamsToConsume.forEach((command) => {
			void consume(command.remoteId, command.kind, currentRtpCapabilities, command.producerId);
		});
	}, [consume, currentVoiceChannelId, streamsToConsume, rtpCapabilities]);
};
