import { useVoiceUsersByChannelId } from '@/features/server/hooks';
import { useVoiceChannelExternalStreamsList } from '@/features/server/voice/hooks';
import { memo, useMemo } from 'react';
import { ControlsBar } from './controls-bar';
import { ExternalStreamCard } from './external-stream-card';
import {
  PinnedCardType,
  usePinCardController
} from './hooks/use-pin-card-controller';
import { ScreenShareCard } from './screen-share-card';
import { VoiceGrid } from './voice-grid';
import { VoiceUserCard } from './voice-user-card';

type TChannelProps = {
  channelId: number;
};

const VoiceChannel = memo(({ channelId }: TChannelProps) => {
  const voiceUsers = useVoiceUsersByChannelId(channelId);
  const externalStreams = useVoiceChannelExternalStreamsList(channelId);
  const { pinnedCard, pinCard, unpinCard, isPinned } = usePinCardController();

  const cards = useMemo(() => {
    const cards: React.ReactNode[] = [];

    voiceUsers.forEach((voiceUser) => {
      const userCardId = `user-${voiceUser.id}`;

      cards.push(
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
        />
      );

      if (voiceUser.state.sharingScreen) {
        const screenShareCardId = `screen-share-${voiceUser.id}`;

        cards.push(
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
          />
        );
      }
    });

    externalStreams.forEach((stream) => {
      const externalStreamCardId = `external-stream-${stream.streamId}`;

      cards.push(
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
        />
      );
    });

    return cards;
  }, [voiceUsers, externalStreams, isPinned, pinCard, unpinCard]);

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
      <VoiceGrid pinnedCardId={pinnedCard?.id} className="h-full">
        {cards}
      </VoiceGrid>
      <ControlsBar channelId={channelId} />
    </div>
  );
});

export { VoiceChannel };
