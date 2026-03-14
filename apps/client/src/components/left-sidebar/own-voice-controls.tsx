import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useChannelCan } from '@/features/server/hooks';
import { useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import { ChannelPermission } from '@sharkord/shared';
import {
  ChevronUp,
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  Volume2,
  VolumeX
} from 'lucide-react';
import { memo, useCallback } from 'react';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Slider } from '../ui/slider';
import { useVolumeControl } from '../voice-provider/volume-control-context';
import {
  MASTER_OUTPUT_VOLUME_KEY,
  OWN_MIC_VOLUME_KEY
} from '../voice-provider/volume-control-storage';

type TVolumeControlButtonProps = {
  className?: string;
  onChange: (values: number[]) => void;
  title: string;
  volume: number;
};

const VolumeControlButton = memo(
  ({ className, onChange, title, volume }: TVolumeControlButtonProps) => {
    const isMuted = volume === 0;

    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-6 rounded-l-none rounded-r-lg px-0 text-muted-foreground transition-colors hover:!bg-white/6 hover:!text-white',
              isMuted &&
                'bg-red-500/12 text-red-300 hover:!bg-red-500/12 hover:!text-red-300',
              className
            )}
            title={title}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          className="w-44 p-3"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            {isMuted ? (
              <VolumeX className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Volume2 className="h-4 w-4 text-muted-foreground" />
            )}
            <Slider
              value={[volume]}
              onValueChange={onChange}
              min={0}
              max={100}
              step={1}
              className="flex-1 cursor-pointer"
            />
            <span className="w-8 text-right text-xs text-muted-foreground">
              {volume}%
            </span>
          </div>
        </PopoverContent>
      </Popover>
    );
  }
);

const OwnVoiceControls = memo(() => {
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const channelCan = useChannelCan(currentVoiceChannelId);
  const { ownVoiceState, toggleMic, toggleSound } = useVoice();
  const { getVolume, setVolume } = useVolumeControl();
  const micVolume = getVolume(OWN_MIC_VOLUME_KEY);
  const outputVolume = getVolume(MASTER_OUTPUT_VOLUME_KEY);

  const handleMicVolumeChange = useCallback(
    (values: number[]) => {
      setVolume(OWN_MIC_VOLUME_KEY, values[0] || 0);
    },
    [setVolume]
  );

  const handleOutputVolumeChange = useCallback(
    (values: number[]) => {
      setVolume(MASTER_OUTPUT_VOLUME_KEY, values[0] || 0);
    },
    [setVolume]
  );

  if (currentVoiceChannelId === undefined) {
    return null;
  }

  return (
    <div className="flex items-center gap-1">
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8 rounded-r-none rounded-l-lg text-muted-foreground transition-colors hover:!bg-white/6 hover:!text-white',
            ownVoiceState.micMuted &&
              'bg-red-500/12 text-red-300 hover:!bg-red-500/12 hover:!text-red-300'
          )}
          onClick={toggleMic}
          title={
            ownVoiceState.micMuted ? 'Unmute microphone' : 'Mute microphone'
          }
          disabled={!channelCan(ChannelPermission.SPEAK)}
        >
          {ownVoiceState.micMuted ? (
            <MicOff className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </Button>

        <VolumeControlButton
          onChange={handleMicVolumeChange}
          title="Microphone volume"
          volume={micVolume}
        />
      </div>

      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8 rounded-r-none rounded-l-lg text-muted-foreground transition-colors hover:!bg-white/6 hover:!text-white',
            ownVoiceState.soundMuted &&
              'bg-red-500/12 text-red-300 hover:!bg-red-500/12 hover:!text-red-300'
          )}
          onClick={toggleSound}
          title={ownVoiceState.soundMuted ? 'Undeafen' : 'Deafen'}
        >
          {ownVoiceState.soundMuted ? (
            <HeadphoneOff className="h-4 w-4" />
          ) : (
            <Headphones className="h-4 w-4" />
          )}
        </Button>

        <VolumeControlButton
          onChange={handleOutputVolumeChange}
          title="Speaker volume"
          volume={outputVolume}
        />
      </div>
    </div>
  );
});

export { OwnVoiceControls };
