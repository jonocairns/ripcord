import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { PinnedCardType } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import { getPendingStreamKey } from '@/components/voice-provider/hooks/use-pending-streams';
import { setSelectedChannelId } from '@/features/server/channels/actions';
import { useCurrentVoiceChannelId, useSelectedChannelId } from '@/features/server/channels/hooks';
import { currentVoiceChannelIdSelector } from '@/features/server/channels/selectors';
import { useServerStore } from '@/features/server/slice';
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
			// Resolves once the media pipeline (transports + mic) is ready, or
			// `false` if media setup failed and the join was rolled back. Undefined
			// when already in the channel (media is already established).
			mediaReady?: Promise<boolean>;
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

			// The user is already visibly in the channel at this point: joinVoice
			// updated the store and played the join sound. Run the media pipeline
			// (transports + mic) in the background so the join feels instant
			// instead of blocking on WebRTC setup. Callers that need media (the
			// stream stage) await `mediaReady`; on failure the join is rolled back.
			const mediaReady = init(joinResult.routerRtpCapabilities, channelId, {
				producerTransportParams: joinResult.producerTransportParams,
				consumerTransportParams: joinResult.consumerTransportParams,
				existingProducers: joinResult.existingProducers,
			})
				.then(() => true)
				.catch(async () => {
					if (currentVoiceChannelIdSelector(useServerStore.getState()) === channelId) {
						await leaveVoiceSilently();
						toast.error('Failed to initialize voice connection');
					}
					return false;
				});

			return {
				joined: true,
				prefetchedProducers: joinResult.existingProducers,
				mediaReady,
			};
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

			// Accepting a remote stream consumes over the consumer transport, so
			// the media pipeline must be up. When we just joined, wait for it (and
			// bail if media setup failed); when already in-channel it is undefined.
			if (result.mediaReady && !(await result.mediaReady)) {
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
