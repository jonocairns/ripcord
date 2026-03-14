import { useChannelById } from '@/features/server/channels/hooks';
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
  const channel = useChannelById(channelId);
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
      <div className="voice-stage relative flex-1 overflow-hidden bg-[radial-gradient(circle_at_top,_rgb(18_36_46),_transparent_40%),linear-gradient(180deg,_rgb(7_11_17),_rgb(4_8_14))] p-6">
        <div className="absolute inset-x-0 top-0 h-48 bg-[radial-gradient(circle_at_top,_rgb(56_189_248_/_0.12),_transparent_55%)]" />
        <div className="relative flex h-full items-center justify-center">
          <div className="rounded-[1.75rem] border border-border/70 bg-card/50 px-8 py-7 text-center shadow-2xl backdrop-blur-md">
            <p className="mb-2 text-lg font-semibold text-foreground">
              {channel?.name ?? 'Voice channel'}
            </p>
            <p className="mb-2 text-base font-medium text-foreground/90">
              No one in the voice channel
            </p>
            <p className="text-sm text-muted-foreground">
              Join the voice channel to start a meeting
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="voice-stage relative flex-1 overflow-hidden bg-[radial-gradient(circle_at_top,_rgb(18_36_46),_transparent_42%),linear-gradient(180deg,_rgb(8_13_20),_rgb(4_7_12))]">
      <div className="absolute inset-x-0 top-0 h-64 bg-[radial-gradient(circle_at_top,_rgb(56_189_248_/_0.14),_transparent_58%)]" />
      <div className="absolute -bottom-24 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-emerald-500/8 blur-3xl" />

      <div className="relative z-10 flex h-full min-h-0 flex-col px-4 pb-4 pt-3 md:px-6 md:pb-6 md:pt-4">
        <div className="min-h-0 flex-1">
          <VoiceGrid pinnedCardId={pinnedCard?.id} className="h-full">
            {cards}
          </VoiceGrid>
        </div>

        <div className="pt-3">
          <ControlsBar channelId={channelId} />
        </div>
      </div>
    </div>
  );
});

export { VoiceChannel };
