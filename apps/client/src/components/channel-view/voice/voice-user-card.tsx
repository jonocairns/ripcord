import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import { UserAvatar } from '@/components/user-avatar';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import type { TVoiceUser } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { HeadphoneOff, MicOff, Monitor, Video } from 'lucide-react';
import { memo, useCallback } from 'react';
import { CardControls } from './card-controls';
import { CardGradient } from './card-gradient';
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
};

const VoiceUserCard = memo(
  ({
    userId,
    onPin,
    onUnpin,
    className,
    isPinned = false,
    showPinControls = true,
    voiceUser
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
        <CardGradient />

        <CardControls>
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
            showStatusBadge={false}
          />
        )}

        <div className="absolute bottom-0 left-0 right-0 z-10 p-2">
          <div className="flex items-center justify-between rounded-md border border-white/10 bg-black/45 px-2 py-1 backdrop-blur-sm">
            <span className="truncate text-sm font-medium text-white">
              {voiceUser.name}
            </span>

            <div className="flex items-center gap-1">
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
