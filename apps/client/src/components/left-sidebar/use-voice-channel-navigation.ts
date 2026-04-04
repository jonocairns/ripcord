import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { PinnedCardType } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import { getPendingStreamKey } from '@/components/voice-provider/hooks/use-pending-streams';
import { setSelectedChannelId } from '@/features/server/channels/actions';
import { useCurrentVoiceChannelId, useSelectedChannelId } from '@/features/server/channels/hooks';
import { joinVoice, leaveVoiceSilently, setPinnedCard } from '@/features/server/voice/actions';
import { useVoice } from '@/features/server/voice/hooks';

type TUserStreamStageTarget = {
	channelId: number;
	userId: number;
	stream: 'camera' | 'screen';
};

type TEnsureJoinedVoiceChannelResult =
	| {
			joined: false;
	  }
	| {
			joined: true;
			prefetchedProducers?: TRemoteProducerIds;
	  };

const useVoiceChannelNavigation = () => {
	const currentVoiceChannelId = useCurrentVoiceChannelId();
	const selectedChannelId = useSelectedChannelId();
	const { acceptStream, init, pendingStreams } = useVoice();

	const ensureJoinedVoiceChannel = useCallback(
		async (channelId: number): Promise<TEnsureJoinedVoiceChannelResult> => {
			if (currentVoiceChannelId === channelId) {
				return { joined: true };
			}

			const joinResult = await joinVoice(channelId);

			if (joinResult.kind === 'already-joined') {
				return { joined: true };
			}

			if (joinResult.kind !== 'joined') {
				return { joined: false };
			}

			try {
				await init(joinResult.routerRtpCapabilities, channelId, {
					producerTransportParams: joinResult.producerTransportParams,
					consumerTransportParams: joinResult.consumerTransportParams,
					existingProducers: joinResult.existingProducers,
				});

				return {
					joined: true,
					prefetchedProducers: joinResult.existingProducers,
				};
			} catch {
				await leaveVoiceSilently();
				toast.error('Failed to initialize voice connection');
				return { joined: false };
			}
		},
		[currentVoiceChannelId, init],
	);

	const joinChannel = useCallback(
		async (channelId: number): Promise<boolean> => {
			const shouldKeepStageOpen = currentVoiceChannelId !== undefined && selectedChannelId === currentVoiceChannelId;
			const result = await ensureJoinedVoiceChannel(channelId);

			if (!result.joined) {
				return false;
			}

			if (shouldKeepStageOpen) {
				setSelectedChannelId(channelId);
			}

			return true;
		},
		[currentVoiceChannelId, ensureJoinedVoiceChannel, selectedChannelId],
	);

	const openUserStreamStage = useCallback(
		async ({ channelId, userId, stream }: TUserStreamStageTarget): Promise<boolean> => {
			const result = await ensureJoinedVoiceChannel(channelId);

			if (!result.joined) {
				return false;
			}

			setSelectedChannelId(channelId);

			if (stream === 'screen') {
				setPinnedCard({
					id: `screen-share-${userId}`,
					type: PinnedCardType.SCREEN_SHARE,
					userId,
				});

				if (
					result.prefetchedProducers?.remoteScreenIds.includes(userId) ||
					pendingStreams.has(getPendingStreamKey(userId, StreamKind.SCREEN))
				) {
					acceptStream(userId, StreamKind.SCREEN);
				}

				if (
					result.prefetchedProducers?.remoteScreenAudioIds.includes(userId) ||
					pendingStreams.has(getPendingStreamKey(userId, StreamKind.SCREEN_AUDIO))
				) {
					acceptStream(userId, StreamKind.SCREEN_AUDIO);
				}

				return true;
			}

			setPinnedCard({
				id: `user-${userId}`,
				type: PinnedCardType.USER,
				userId,
			});

			if (
				result.prefetchedProducers?.remoteVideoIds.includes(userId) ||
				pendingStreams.has(getPendingStreamKey(userId, StreamKind.VIDEO))
			) {
				acceptStream(userId, StreamKind.VIDEO);
			}

			return true;
		},
		[acceptStream, ensureJoinedVoiceChannel, pendingStreams],
	);

	return {
		joinChannel,
		openUserStreamStage,
	};
};

export { useVoiceChannelNavigation };
