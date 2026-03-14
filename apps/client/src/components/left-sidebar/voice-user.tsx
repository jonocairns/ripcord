import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { UserAvatar } from '@/components/user-avatar';
import type { TVoiceUser } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import {
  HeadphoneOff,
  MicOff,
  Monitor,
  Video,
  Volume2,
  VolumeX
} from 'lucide-react';
import { memo, useCallback } from 'react';
import { useVoiceRefs } from '../channel-view/voice/hooks/use-voice-refs';
import { UserPopover } from '../user-popover';
import { useVolumeControl } from '../voice-provider/volume-control-context';

type TVoiceUserProps = {
  user: TVoiceUser;
};

const VoiceUser = memo(({ user }: TVoiceUserProps) => {
  const { isSpeaking, speakingIntensity } = useVoiceRefs(user.id);
  const ownUserId = useOwnUserId();
  const { getUserVolumeKey, getVolume, setVolume, toggleMute } =
    useVolumeControl();
  const isOwnUser = user.id === ownUserId;
  const volumeKey = getUserVolumeKey(user.id);
  const volume = getVolume(volumeKey);
  const isMuted = volume === 0;
  const isActivelySpeaking = !user.state.micMuted && isSpeaking;
  const isLive = user.state.webcamEnabled || user.state.sharingScreen;
  const statusLabel = isActivelySpeaking
    ? 'Speaking'
    : user.state.micMuted
      ? 'Muted'
      : isLive
        ? 'Broadcasting'
        : undefined;
  const handleVolumeChange = useCallback(
    (values: number[]) => {
      setVolume(volumeKey, values[0] || 0);
    },
    [setVolume, volumeKey]
  );
  const handleToggleMute = useCallback(() => {
    toggleMute(volumeKey);
  }, [toggleMute, volumeKey]);

  return (
    <UserPopover
      userId={user.id}
      footer={
        !isOwnUser && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Voice volume</p>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleToggleMute}
                className="h-6 w-6 p-0"
              >
                {isMuted ? (
                  <VolumeX className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </Button>
              <Slider
                value={[volume]}
                onValueChange={handleVolumeChange}
                min={0}
                max={100}
                step={1}
                className="flex-1 cursor-pointer"
              />
              <span className="text-xs text-muted-foreground w-8 text-right">
                {volume}%
              </span>
            </div>
          </div>
        )
      }
    >
      <div className="group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-accent/35">
        <UserAvatar
          userId={user.id}
          className={cn(
            'h-7 w-7 ring-1 ring-transparent transition-all',
            isActivelySpeaking
              ? speakingIntensity === 1
                ? 'speaking-effect-low'
                : speakingIntensity === 2
                  ? 'speaking-effect-medium'
                  : 'speaking-effect-high'
              : 'group-hover:ring-white/10'
          )}
          showUserPopover={false}
          showStatusBadge={false}
        />

        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground/90">
            {user.name}
          </span>
          {statusLabel && (
            <span className="block truncate text-[11px] text-muted-foreground">
              {statusLabel}
            </span>
          )}
        </div>

        {isLive && (
          <Badge className="border-transparent bg-red-500/90 px-1.5 py-0 text-[10px] font-bold tracking-[0.12em] text-white">
            LIVE
          </Badge>
        )}

        <div className="flex items-center gap-1 opacity-60">
          {user.state.micMuted && <MicOff className="h-3 w-3 text-red-500" />}

          {user.state.soundMuted && (
            <HeadphoneOff className="h-3 w-3 text-red-500" />
          )}

          {user.state.webcamEnabled && (
            <Video className="h-3 w-3 text-blue-500" />
          )}

          {user.state.sharingScreen && (
            <Monitor className="h-3 w-3 text-purple-500" />
          )}
        </div>
      </div>
    </UserPopover>
  );
});

export { VoiceUser };
