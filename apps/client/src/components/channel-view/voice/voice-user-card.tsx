import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import { IconButton } from '@/components/ui/icon-button';
import { UserAvatar } from '@/components/user-avatar';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import type { TVoiceUser } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { EyeOff, HeadphoneOff, MicOff, Monitor, Video } from 'lucide-react';
import { memo, useCallback } from 'react';
import { CardControls } from './card-controls';
import { useVoiceRefs } from './hooks/use-voice-refs';
import { PinButton } from './pin-button';
import { VolumeButton } from './volume-button';

type TVoiceUserCardProps = {
  userId: number;
  onPin: () => void;
  onUnpin: () => void;
  showPinControls?: boolean;
  voiceUser: TVoiceUser;
  className?: string;
  isPinned?: boolean;
  onStopWatching?: () => void;
};

const VoiceUserCard = memo(
  ({
    userId,
    onPin,
    onUnpin,
    className,
    isPinned = false,
    showPinControls = true,
    voiceUser,
    onStopWatching
  }: TVoiceUserCardProps) => {
    const { videoRef, hasVideoStream, isSpeaking, speakingIntensity } =
      useVoiceRefs(userId);
    const { getUserVolumeKey } = useVolumeControl();
    const { devices } = useDevices();
    const ownUserId = useOwnUserId();
    const isOwnUser = userId === ownUserId;

    const handlePinToggle = useCallback(() => {
      if (isPinned) {
        onUnpin?.();
      } else {
        onPin?.();
      }
    }, [isPinned, onPin, onUnpin]);

    const isActivelySpeaking = !voiceUser.state.micMuted && isSpeaking;

    return (
      <div
        className={cn(
          'relative bg-card rounded-xl overflow-hidden group',
          'flex items-center justify-center',
          'w-full h-full',
          'border border-border/70 shadow-[0_10px_32px_rgb(0_0_0/0.38)]',
          isActivelySpeaking
            ? speakingIntensity === 1
              ? 'speaking-effect-low'
              : speakingIntensity === 2
                ? 'speaking-effect-medium'
                : 'speaking-effect-high'
            : '',
          className
        )}
      >
        <CardControls>
          {!isOwnUser && hasVideoStream && onStopWatching && (
            <IconButton
              variant="ghost"
              icon={EyeOff}
              onClick={onStopWatching}
              title="Stop Watching"
              size="sm"
            />
          )}
          {!isOwnUser && <VolumeButton volumeKey={getUserVolumeKey(userId)} />}
          {showPinControls && (
            <PinButton isPinned={isPinned} handlePinToggle={handlePinToggle} />
          )}
        </CardControls>

        {hasVideoStream && (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className={cn(
              'absolute inset-0 h-full w-full bg-black/40 object-contain',
              isOwnUser && devices.mirrorOwnVideo && '-scale-x-100'
            )}
          />
        )}
        {!hasVideoStream && (
          <UserAvatar
            userId={userId}
            className="h-20 w-20 md:h-24 md:w-24 lg:h-28 lg:w-28"
            fallbackClassName="text-2xl md:text-3xl lg:text-4xl"
            showStatusBadge={false}
          />
        )}

        <div className="absolute bottom-0 left-0 right-0 z-10 p-2">
          <div className="relative flex w-fit max-w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 shadow-lg backdrop-blur-sm">
            <span className="max-w-[14ch] truncate text-xs font-semibold text-white/95 md:max-w-[22ch] md:text-sm">
              {voiceUser.name}
            </span>

            <div className="ml-0.5 flex items-center gap-1">
              {voiceUser.state.micMuted && (
                <MicOff className="size-3.5 text-red-500/80" />
              )}

              {voiceUser.state.soundMuted && (
                <HeadphoneOff className="size-3.5 text-red-500/80" />
              )}

              {voiceUser.state.webcamEnabled && (
                <Video className="size-3.5 text-sky-400/90" />
              )}

              {voiceUser.state.sharingScreen && (
                <Monitor className="size-3.5 text-cyan-400/90" />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
);

VoiceUserCard.displayName = 'VoiceUserCard';

export { VoiceUserCard };
