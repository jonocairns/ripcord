import { useVoiceUsersByChannelId } from '@/features/server/hooks';
import {
  useVoice,
  useVoiceChannelExternalStreamsList
} from '@/features/server/voice/hooks';
import { StreamKind } from '@sharkord/shared';
import { memo, useMemo } from 'react';
import { getPendingStreamKey } from '../../voice-provider/hooks/use-pending-streams';
import { ControlsBar } from './controls-bar';
import { ExternalStreamCard } from './external-stream-card';
import {
  PinnedCardType,
  usePinCardController
} from './hooks/use-pin-card-controller';
import { PendingStreamCard } from './pending-stream-card';
import { ScreenShareCard } from './screen-share-card';
import { VoiceGrid } from './voice-grid';
import { VoiceUserCard } from './voice-user-card';

type TChannelProps = {
  channelId: number;
};

const VoiceChannel = memo(({ channelId }: TChannelProps) => {
  const voiceUsers = useVoiceUsersByChannelId(channelId);
  const externalStreams = useVoiceChannelExternalStreamsList(channelId);
  const {
    acceptStream,
    stopWatchingStream,
    pendingStreams,
    remoteUserStreams,
    externalStreams: activeExternalStreams
  } = useVoice();
  const { pinnedCard, pinCard, unpinCard, isPinned } = usePinCardController();

  const cards = useMemo(() => {
    const cards: React.ReactNode[] = [];

    voiceUsers.forEach((voiceUser) => {
      const userCardId = `user-${voiceUser.id}`;
      const hasPendingVideo = pendingStreams.has(
        getPendingStreamKey(voiceUser.id, StreamKind.VIDEO)
      );
      const hasConsumedVideo =
        !!remoteUserStreams[voiceUser.id]?.[StreamKind.VIDEO];

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
            isPinned={isPinned(userCardId)}
            onPin={() =>
              pinCard({
                id: userCardId,
                type: PinnedCardType.USER,
                userId: voiceUser.id
              })
            }
            onUnpin={unpinCard}
            voiceUser={voiceUser}
            onStopWatching={() => {
              stopWatchingStream(voiceUser.id, StreamKind.VIDEO);
            }}
          />
        )
      );

      if (voiceUser.state.sharingScreen) {
        const screenShareCardId = `screen-share-${voiceUser.id}`;
        const hasPendingScreen = pendingStreams.has(
          getPendingStreamKey(voiceUser.id, StreamKind.SCREEN)
        );
        const hasPendingScreenAudio = pendingStreams.has(
          getPendingStreamKey(voiceUser.id, StreamKind.SCREEN_AUDIO)
        );
        const hasConsumedScreen =
          !!remoteUserStreams[voiceUser.id]?.[StreamKind.SCREEN];
        const showPendingScreenCard =
          hasPendingScreen || (!hasConsumedScreen && hasPendingScreenAudio);

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
              isPinned={isPinned(screenShareCardId)}
              onPin={() =>
                pinCard({
                  id: screenShareCardId,
                  type: PinnedCardType.SCREEN_SHARE,
                  userId: voiceUser.id
                })
              }
              onUnpin={unpinCard}
              showPinControls
              onStopWatching={() => {
                stopWatchingStream(voiceUser.id, StreamKind.SCREEN);

                if (
                  remoteUserStreams[voiceUser.id]?.[StreamKind.SCREEN_AUDIO]
                ) {
                  stopWatchingStream(voiceUser.id, StreamKind.SCREEN_AUDIO);
                }
              }}
            />
          )
        );
      }
    });

    externalStreams.forEach((stream) => {
      const externalStreamCardId = `external-stream-${stream.streamId}`;
      const hasPendingExternalVideo = pendingStreams.has(
        getPendingStreamKey(stream.streamId, StreamKind.EXTERNAL_VIDEO)
      );
      const hasPendingExternalAudio = pendingStreams.has(
        getPendingStreamKey(stream.streamId, StreamKind.EXTERNAL_AUDIO)
      );
      const hasConsumedExternalMedia =
        !!activeExternalStreams[stream.streamId]?.audioStream ||
        !!activeExternalStreams[stream.streamId]?.videoStream;
      const showPendingExternalCard =
        !hasConsumedExternalMedia &&
        (hasPendingExternalVideo || hasPendingExternalAudio);

      cards.push(
        showPendingExternalCard ? (
          <PendingStreamCard
            key={externalStreamCardId}
            kind={
              hasPendingExternalVideo
                ? StreamKind.EXTERNAL_VIDEO
                : StreamKind.EXTERNAL_AUDIO
            }
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
            isPinned={isPinned(externalStreamCardId)}
            onPin={() =>
              pinCard({
                id: externalStreamCardId,
                type: PinnedCardType.EXTERNAL_STREAM,
                userId: stream.streamId
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
        )
      );
    });

    return cards;
  }, [
    voiceUsers,
    externalStreams,
    activeExternalStreams,
    acceptStream,
    stopWatchingStream,
    pendingStreams,
    remoteUserStreams,
    isPinned,
    pinCard,
    unpinCard
  ]);

  if (voiceUsers.length === 0) {
    return (
      <div className="voice-stage relative flex-1 flex items-center justify-center p-6">
        <div className="rounded-2xl border border-border/70 bg-card/40 px-8 py-6 text-center shadow-2xl backdrop-blur-md">
          <p className="text-foreground text-lg font-semibold mb-2">
            No one in the voice channel
          </p>
          <p className="text-muted-foreground text-sm">
            Join the voice channel to start a meeting
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="voice-stage relative flex-1 overflow-hidden">
      <VoiceGrid pinnedCardId={pinnedCard?.id} className="h-full pb-24">
        {cards}
      </VoiceGrid>
      <ControlsBar channelId={channelId} />
    </div>
  );
});

export { VoiceChannel };
