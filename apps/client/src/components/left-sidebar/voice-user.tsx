import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { UserAvatar } from '@/components/user-avatar';
import type { TVoiceUser } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  Monitor,
  Video,
  Volume2,
  VolumeX
} from 'lucide-react';
import { memo, useCallback } from 'react';
import { useVoiceRefs } from '../channel-view/voice/hooks/use-voice-refs';
import { useVolumeControl } from '../voice-provider/volume-control-context';
import { UserPopover } from '../user-popover';

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
      <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/30 text-sm">
        <UserAvatar
          userId={user.id}
          className={cn(
            'h-5 w-5',
            isActivelySpeaking
              ? speakingIntensity === 1
                ? 'speaking-effect-low'
                : speakingIntensity === 2
                  ? 'speaking-effect-medium'
                  : 'speaking-effect-high'
              : ''
          )}
          showUserPopover={false}
          showStatusBadge={false}
        />

        <span className="flex-1 text-muted-foreground truncate text-xs">
          {user.name}
        </span>

        <div className="flex items-center gap-1 opacity-60">
          <div>
            {user.state.micMuted ? (
              <MicOff className="h-3 w-3 text-red-500" />
            ) : (
              <Mic className="h-3 w-3 text-green-500" />
            )}
          </div>

          <div>
            {user.state.soundMuted ? (
              <HeadphoneOff className="h-3 w-3 text-red-500" />
            ) : (
              <Headphones className="h-3 w-3 text-green-500" />
            )}
          </div>

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
