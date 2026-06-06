import { StreamKind } from '@sharkord/shared';
import { memo, useCallback, useMemo } from 'react';
import { setSelectedChannelId } from '@/features/server/channels/actions';
import { useLastTextChannelId } from '@/features/server/channels/hooks';
import { useVoiceUsersByChannelId } from '@/features/server/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { useVoice, useVoiceChannelExternalStreamsList } from '@/features/server/voice/hooks';
import { getPendingStreamKey } from '../../voice-provider/hooks/use-pending-streams';
import { ControlsBar } from './controls-bar';
import { ExternalStreamCard } from './external-stream-card';
import { PinnedCardType, usePinCardController } from './hooks/use-pin-card-controller';
import { PendingStreamCard } from './pending-stream-card';
import { ScreenShareCard } from './screen-share-card';
import { StartingScreenShareCard } from './starting-screen-share-card';
import { VoiceGrid } from './voice-grid';
import { VoiceUserCard } from './voice-user-card';

type TChannelProps = {
	channelId: number;
};

const VoiceChannel = memo(({ channelId }: TChannelProps) => {
	const voiceUsers = useVoiceUsersByChannelId(channelId);
	const externalStreams = useVoiceChannelExternalStreamsList(channelId);
	const lastTextChannelId = useLastTextChannelId();
	const ownUserId = useOwnUserId();
	const {
		acceptStream,
		isStartingScreenShare,
		stopWatchingStream,
		pendingStreams,
		remoteUserStreams,
		externalStreams: activeExternalStreams,
	} = useVoice();
	const { pinnedCard, pinCard, unpinCard } = usePinCardController();
	const effectivePinnedCard = useMemo(() => {
		if (!pinnedCard) {
			return undefined;
		}

		if (pinnedCard.type !== PinnedCardType.USER) {
			return pinnedCard;
		}

		const voiceUser = voiceUsers.find((user) => user.id === pinnedCard.userId);

		if (!voiceUser) {
			return undefined;
		}

		const hasPendingVideo = pendingStreams.has(getPendingStreamKey(voiceUser.id, StreamKind.VIDEO));
		const hasConsumedVideo = !!remoteUserStreams[voiceUser.id]?.[StreamKind.VIDEO];

		if (voiceUser.state.sharingScreen && !hasConsumedVideo && !hasPendingVideo) {
			return {
				...pinnedCard,
				id: `screen-share-${voiceUser.id}`,
				type: PinnedCardType.SCREEN_SHARE,
			};
		}

		return pinnedCard;
	}, [pendingStreams, pinnedCard, remoteUserStreams, voiceUsers]);
	const handleExitStage = useCallback(() => {
		if (effectivePinnedCard?.type === PinnedCardType.USER && effectivePinnedCard.userId !== ownUserId) {
			stopWatchingStream(effectivePinnedCard.userId, StreamKind.VIDEO);
		}

		if (effectivePinnedCard?.type === PinnedCardType.SCREEN_SHARE && effectivePinnedCard.userId !== ownUserId) {
			stopWatchingStream(effectivePinnedCard.userId, StreamKind.SCREEN);

			if (remoteUserStreams[effectivePinnedCard.userId]?.[StreamKind.SCREEN_AUDIO]) {
				stopWatchingStream(effectivePinnedCard.userId, StreamKind.SCREEN_AUDIO);
			}
		}

		if (effectivePinnedCard?.type === PinnedCardType.EXTERNAL_STREAM) {
			if (activeExternalStreams[effectivePinnedCard.userId]?.videoStream) {
				stopWatchingStream(effectivePinnedCard.userId, StreamKind.EXTERNAL_VIDEO);
			}

			if (activeExternalStreams[effectivePinnedCard.userId]?.audioStream) {
				stopWatchingStream(effectivePinnedCard.userId, StreamKind.EXTERNAL_AUDIO);
			}
		}

		unpinCard();
		setSelectedChannelId(lastTextChannelId);
	}, [
		activeExternalStreams,
		effectivePinnedCard,
		lastTextChannelId,
		ownUserId,
		remoteUserStreams,
		stopWatchingStream,
		unpinCard,
	]);

	const cards = useMemo(() => {
		const cards: React.ReactNode[] = [];

		voiceUsers.forEach((voiceUser) => {
			const userCardId = `user-${voiceUser.id}`;
			const hasPendingVideo = pendingStreams.has(getPendingStreamKey(voiceUser.id, StreamKind.VIDEO));
			const hasConsumedVideo = !!remoteUserStreams[voiceUser.id]?.[StreamKind.VIDEO];

			// Suppress the avatar fallback tile when the user is screen-sharing without a
			// camera — their screen-share card stands in for them, so we avoid a dead
			// avatar tile sitting next to it. Camera-on users still get their own tile.
			const isAvatarOnlyWhileSharing = voiceUser.state.sharingScreen && !hasConsumedVideo && !hasPendingVideo;

			if (!isAvatarOnlyWhileSharing) {
				cards.push(
					hasPendingVideo && !hasConsumedVideo ? (
						<PendingStreamCard
							key={userCardId}
							kind={StreamKind.VIDEO}
							userId={voiceUser.id}
							onWatch={() => {
								acceptStream(voiceUser.id, StreamKind.VIDEO);
							}}
						/>
					) : (
						<VoiceUserCard
							key={userCardId}
							userId={voiceUser.id}
							isPinned={effectivePinnedCard?.id === userCardId}
							onPin={() =>
								pinCard({
									id: userCardId,
									type: PinnedCardType.USER,
									userId: voiceUser.id,
								})
							}
							onUnpin={unpinCard}
							voiceUser={voiceUser}
							onStopWatching={() => {
								stopWatchingStream(voiceUser.id, StreamKind.VIDEO);
							}}
						/>
					),
				);
			}

			if (voiceUser.id === ownUserId && isStartingScreenShare && !voiceUser.state.sharingScreen) {
				cards.push(<StartingScreenShareCard key={`screen-share-${voiceUser.id}`} />);
			}

			if (voiceUser.state.sharingScreen) {
				const screenShareCardId = `screen-share-${voiceUser.id}`;
				const hasPendingScreen = pendingStreams.has(getPendingStreamKey(voiceUser.id, StreamKind.SCREEN));
				const hasPendingScreenAudio = pendingStreams.has(getPendingStreamKey(voiceUser.id, StreamKind.SCREEN_AUDIO));
				const hasConsumedScreen = !!remoteUserStreams[voiceUser.id]?.[StreamKind.SCREEN];
				const showPendingScreenCard = hasPendingScreen || (!hasConsumedScreen && hasPendingScreenAudio);

				cards.push(
					showPendingScreenCard ? (
						<PendingStreamCard
							key={screenShareCardId}
							kind={StreamKind.SCREEN}
							userId={voiceUser.id}
							onWatch={() => {
								if (hasPendingScreen) {
									acceptStream(voiceUser.id, StreamKind.SCREEN);
								}

								if (hasPendingScreenAudio) {
									acceptStream(voiceUser.id, StreamKind.SCREEN_AUDIO);
								}
							}}
						/>
					) : (
						<ScreenShareCard
							key={screenShareCardId}
							userId={voiceUser.id}
							isPinned={effectivePinnedCard?.id === screenShareCardId}
							onPin={() =>
								pinCard({
									id: screenShareCardId,
									type: PinnedCardType.SCREEN_SHARE,
									userId: voiceUser.id,
								})
							}
							onUnpin={unpinCard}
							showPinControls
							onStopWatching={() => {
								stopWatchingStream(voiceUser.id, StreamKind.SCREEN);

								if (remoteUserStreams[voiceUser.id]?.[StreamKind.SCREEN_AUDIO]) {
									stopWatchingStream(voiceUser.id, StreamKind.SCREEN_AUDIO);
								}
							}}
						/>
					),
				);
			}
		});

		externalStreams.forEach((stream) => {
			const externalStreamCardId = `external-stream-${stream.streamId}`;
			const hasPendingExternalVideo = pendingStreams.has(
				getPendingStreamKey(stream.streamId, StreamKind.EXTERNAL_VIDEO),
			);
			const hasPendingExternalAudio = pendingStreams.has(
				getPendingStreamKey(stream.streamId, StreamKind.EXTERNAL_AUDIO),
			);
			const hasConsumedExternalMedia =
				!!activeExternalStreams[stream.streamId]?.audioStream || !!activeExternalStreams[stream.streamId]?.videoStream;
			const showPendingExternalCard = !hasConsumedExternalMedia && (hasPendingExternalVideo || hasPendingExternalAudio);

			cards.push(
				showPendingExternalCard ? (
					<PendingStreamCard
						key={externalStreamCardId}
						kind={hasPendingExternalVideo ? StreamKind.EXTERNAL_VIDEO : StreamKind.EXTERNAL_AUDIO}
						streamTitle={stream.title || 'External Stream'}
						streamAvatarUrl={stream.avatarUrl}
						onWatch={() => {
							if (hasPendingExternalVideo) {
								acceptStream(stream.streamId, StreamKind.EXTERNAL_VIDEO);
							}

							if (hasPendingExternalAudio) {
								acceptStream(stream.streamId, StreamKind.EXTERNAL_AUDIO);
							}
						}}
					/>
				) : (
					<ExternalStreamCard
						key={externalStreamCardId}
						streamId={stream.streamId}
						stream={stream}
						isPinned={effectivePinnedCard?.id === externalStreamCardId}
						onPin={() =>
							pinCard({
								id: externalStreamCardId,
								type: PinnedCardType.EXTERNAL_STREAM,
								userId: stream.streamId,
							})
						}
						onUnpin={unpinCard}
						showPinControls
						onStopWatching={() => {
							if (activeExternalStreams[stream.streamId]?.videoStream) {
								stopWatchingStream(stream.streamId, StreamKind.EXTERNAL_VIDEO);
							}

							if (activeExternalStreams[stream.streamId]?.audioStream) {
								stopWatchingStream(stream.streamId, StreamKind.EXTERNAL_AUDIO);
							}
						}}
					/>
				),
			);
		});

		return cards;
	}, [
		voiceUsers,
		externalStreams,
		activeExternalStreams,
		acceptStream,
		isStartingScreenShare,
		stopWatchingStream,
		pendingStreams,
		remoteUserStreams,
		effectivePinnedCard,
		ownUserId,
		pinCard,
		unpinCard,
	]);

	if (voiceUsers.length === 0) {
		return (
			<div className="voice-stage relative flex-1 flex items-center justify-center p-6">
				<div className="rounded-2xl border border-border/70 bg-card/40 px-8 py-6 text-center shadow-2xl backdrop-blur-md">
					<p className="text-foreground text-lg font-semibold mb-2">No one in the voice channel</p>
					<p className="text-muted-foreground text-sm">Join the voice channel to start a meeting</p>
				</div>
			</div>
		);
	}

	return (
		<div className="voice-stage relative flex-1 overflow-hidden">
			<VoiceGrid pinnedCardId={effectivePinnedCard?.id} className="h-full pb-24">
				{cards}
			</VoiceGrid>
			<ControlsBar channelId={channelId} onExitStage={effectivePinnedCard ? handleExitStage : undefined} />
		</div>
	);
});

export { VoiceChannel };
