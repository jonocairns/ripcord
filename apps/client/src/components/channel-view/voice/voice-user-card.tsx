import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import { IconButton } from '@/components/ui/icon-button';
import { UserAvatar } from '@/components/user-avatar';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import type { TVoiceUser } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { EyeOff, HeadphoneOff, MicOff, Monitor, Video } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
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
    const isActivelySpeaking = !voiceUser.state.micMuted && isSpeaking;
    const isLive =
      voiceUser.state.webcamEnabled || voiceUser.state.sharingScreen;
    const stageLabel = useMemo(() => {
      if (voiceUser.state.micMuted) {
        return 'Muted';
      }

      if (isActivelySpeaking) {
        return 'Speaking';
      }

      if (voiceUser.state.sharingScreen) {
        return 'Presenting';
      }

      if (voiceUser.state.webcamEnabled) {
        return 'Camera on';
      }
    }, [
      isActivelySpeaking,
      voiceUser.state.micMuted,
      voiceUser.state.sharingScreen,
      voiceUser.state.webcamEnabled
    ]);

    const handlePinToggle = useCallback(() => {
      if (isPinned) {
        onUnpin?.();
      } else {
        onPin?.();
      }
    }, [isPinned, onPin, onUnpin]);

    return (
      <div
        className={cn(
          'group relative h-full w-full overflow-hidden rounded-[1.6rem] border border-border/70 bg-card/92',
          'flex items-center justify-center',
          'shadow-[0_20px_48px_rgb(0_0_0/0.36)]',
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
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgb(34_197_94_/_0.08),_transparent_40%),linear-gradient(180deg,_rgb(24_29_37),_rgb(16_18_24))]" />

        <CardControls>
          {!isOwnUser && hasVideoStream && onStopWatching && (
            <IconButton
              variant="ghost"
              icon={EyeOff}
              onClick={onStopWatching}
              title="Stop Watching"
              size="default"
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
              'absolute inset-0 h-full w-full bg-black/40 object-cover',
              isOwnUser && devices.mirrorOwnVideo && '-scale-x-100'
            )}
          />
        )}
        {!hasVideoStream && (
          <div className="relative z-[2] flex flex-col items-center gap-4">
            <div
              className={cn(
                'rounded-full p-2 shadow-[0_18px_30px_rgb(0_0_0/0.32)]',
                isActivelySpeaking
                  ? 'bg-emerald-500/18 ring-4 ring-emerald-400/25'
                  : 'bg-white/6 ring-1 ring-white/10'
              )}
            >
              <UserAvatar
                userId={userId}
                className="h-28 w-28 md:h-32 md:w-32 lg:h-36 lg:w-36"
                fallbackClassName="text-3xl md:text-4xl lg:text-5xl"
                showStatusBadge={false}
              />
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-foreground">
                {voiceUser.name}
              </p>
              {stageLabel && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {stageLabel}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="absolute left-4 top-4 z-[2] flex items-center gap-2">
          {stageLabel && (
            <span
              className={cn(
                'rounded-full border px-2.5 py-1 text-[11px] font-medium backdrop-blur-md',
                isActivelySpeaking
                  ? 'border-emerald-500/30 bg-emerald-500/14 text-emerald-200'
                  : 'border-border/80 bg-background/55 text-muted-foreground'
              )}
            >
              {stageLabel}
            </span>
          )}
          {isLive && (
            <span className="rounded-full border border-sky-500/30 bg-sky-500/14 px-2.5 py-1 text-[11px] font-medium text-sky-200">
              {voiceUser.state.sharingScreen ? 'Sharing' : 'Live'}
            </span>
          )}
        </div>

        <CardGradient />

        <div className="absolute bottom-0 left-0 right-0 z-[2] p-4">
          <div className="flex items-end gap-3">
            {hasVideoStream && (
              <UserAvatar
                userId={userId}
                className="h-14 w-14 ring-2 ring-white/10"
                fallbackClassName="text-lg"
                showStatusBadge={false}
              />
            )}

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-white">
                  {voiceUser.name}
                </span>
                {isOwnUser && (
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/75">
                    You
                  </span>
                )}
              </div>
              {stageLabel && (
                <p className="mt-1 text-xs text-white/70">{stageLabel}</p>
              )}
            </div>

            <div className="ml-auto flex items-center gap-1.5 rounded-full bg-black/25 px-2.5 py-1 backdrop-blur-sm">
              {voiceUser.state.micMuted && (
                <MicOff className="size-3.5 text-red-400" />
              )}
              {voiceUser.state.soundMuted && (
                <HeadphoneOff className="size-3.5 text-red-400" />
              )}
              {voiceUser.state.webcamEnabled && (
                <Video className="size-3.5 text-sky-300" />
              )}
              {voiceUser.state.sharingScreen && (
                <Monitor className="size-3.5 text-cyan-300" />
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
