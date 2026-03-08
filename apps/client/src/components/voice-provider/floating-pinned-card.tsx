import { setSelectedChannelId } from '@/features/server/channels/actions';
import {
  useCurrentVoiceChannelId,
  useIsCurrentVoiceChannelSelected
} from '@/features/server/channels/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import {
  usePinnedCard,
  useVoiceChannelExternalStreamsList
} from '@/features/server/voice/hooks';
import type { TRemoteStreams } from '@/types';
import { ArrowDownLeft, SendToBack, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardControls } from '../channel-view/voice/card-controls';
import { PinnedCardType } from '../channel-view/voice/hooks/use-pin-card-controller';
import { IconButton } from '../ui/icon-button';
import { useFloatingCard } from './hooks/use-floating-card';
import type { TExternalStreamsMap } from './hooks/use-remote-streams';

type TFloatingPinnedCardProps = {
  remoteUserStreams: TRemoteStreams;
  externalStreams: TExternalStreamsMap;
  localVideoStream: MediaStream | undefined;
  localScreenShareStream: MediaStream | undefined;
};

type TFloatingCardContent = {
  id: string;
  title: string;
  videoStream: MediaStream;
};

const FloatingPinnedCard = memo(
  ({
    remoteUserStreams,
    externalStreams,
    localVideoStream,
    localScreenShareStream
  }: TFloatingPinnedCardProps) => {
    const { cardRef, handleMouseDown, getStyle, resetCard } = useFloatingCard();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [open, setOpen] = useState(true);
    const pinnedCard = usePinnedCard();
    const ownUserId = useOwnUserId();
    const currentVoiceChannelId = useCurrentVoiceChannelId();
    const isCurrentVoiceChannelSelected = useIsCurrentVoiceChannelSelected();
    const currentVoiceChannelExternalStreams =
      useVoiceChannelExternalStreamsList(currentVoiceChannelId ?? -1);
    const pinnedUser = useUserById(pinnedCard?.userId || -1);

    const isExternalStream =
      pinnedCard?.type === PinnedCardType.EXTERNAL_STREAM;

    const floatingCardContent = useMemo<
      TFloatingCardContent | undefined
    >(() => {
      if (pinnedCard) {
        if (isExternalStream) {
          const externalStreamState = externalStreams[pinnedCard.userId];
          const externalStream = currentVoiceChannelExternalStreams.find(
            (stream) => stream.streamId === pinnedCard.userId
          );

          if (!externalStreamState?.videoStream) {
            return undefined;
          }

          return {
            id: pinnedCard.id,
            title: externalStream?.title || 'External Stream',
            videoStream: externalStreamState.videoStream
          };
        }

        if (pinnedCard.userId === ownUserId) {
          const ownVideoStream = localScreenShareStream || localVideoStream;

          return ownVideoStream
            ? {
                id: pinnedCard.id,
                title: 'Your Stream',
                videoStream: ownVideoStream
              }
            : undefined;
        }

        const streamInfo = remoteUserStreams[pinnedCard.userId];
        const remoteVideoStream = streamInfo?.screen || streamInfo?.video;

        return remoteVideoStream
          ? {
              id: pinnedCard.id,
              title: pinnedUser?.name || 'Pinned Stream',
              videoStream: remoteVideoStream
            }
          : undefined;
      }

      if (currentVoiceChannelId === undefined) {
        return undefined;
      }

      const iptvStream = currentVoiceChannelExternalStreams.find(
        (stream) => stream.key === `iptv:${currentVoiceChannelId}`
      );

      if (!iptvStream) {
        return undefined;
      }

      const iptvVideoStream = externalStreams[iptvStream.streamId]?.videoStream;

      return iptvVideoStream
        ? {
            id: `external-stream-${iptvStream.streamId}`,
            title: iptvStream.title || 'IPTV',
            videoStream: iptvVideoStream
          }
        : undefined;
    }, [
      currentVoiceChannelExternalStreams,
      currentVoiceChannelId,
      externalStreams,
      isExternalStream,
      localScreenShareStream,
      localVideoStream,
      ownUserId,
      pinnedCard,
      pinnedUser?.name,
      remoteUserStreams
    ]);

    const onCloseClick = useCallback(() => {
      setOpen(false);
    }, []);

    const onGoToVoiceChannelClick = useCallback(() => {
      if (currentVoiceChannelId === undefined) {
        return;
      }

      setSelectedChannelId(currentVoiceChannelId);
    }, [currentVoiceChannelId]);

    useEffect(() => {
      if (videoRef.current && floatingCardContent?.videoStream) {
        videoRef.current.srcObject = floatingCardContent.videoStream;
      }
    }, [floatingCardContent?.videoStream, isCurrentVoiceChannelSelected]);

    useEffect(() => {
      setOpen(true);
    }, [floatingCardContent?.id, isCurrentVoiceChannelSelected]);

    if (!floatingCardContent || isCurrentVoiceChannelSelected || !open) {
      return null;
    }

    return (
      <div
        ref={cardRef}
        onMouseDown={handleMouseDown}
        className="absolute z-50 cursor-move select-none w-96 aspect-video rounded-lg overflow-hidden border border-border bg-black shadow-lg group"
        style={getStyle()}
      >
        <CardControls>
          <IconButton
            icon={ArrowDownLeft}
            size="sm"
            variant="ghost"
            title="Go To Voice Channel"
            onClick={onGoToVoiceChannelClick}
          />
          <IconButton
            icon={SendToBack}
            size="sm"
            variant="ghost"
            title="Reset Position"
            onClick={resetCard}
          />
          <IconButton
            icon={X}
            size="sm"
            variant="ghost"
            title="Close"
            onClick={onCloseClick}
          />
        </CardControls>

        {floatingCardContent.title && (
          <div className="absolute bottom-2 left-2 bg-black/50 rounded-md px-2 py-1 text-xs z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            {floatingCardContent.title}
          </div>
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain"
        />
      </div>
    );
  }
);

FloatingPinnedCard.displayName = 'FloatingPinnedCard';

export { FloatingPinnedCard };
