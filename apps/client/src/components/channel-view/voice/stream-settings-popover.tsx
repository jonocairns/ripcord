import { IconButton } from '@/components/ui/icon-button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { Settings, Volume2, VolumeX } from 'lucide-react';
import { memo } from 'react';
import type { StreamStats } from './hooks/use-stream-stats';

type TStreamSettingsPopoverProps = {
  volume: number;
  isMuted: boolean;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  buttonClassName?: string;
  buttonSize?: 'sm' | 'default' | 'lg' | 'xl' | 'xs';
  streamStats?: StreamStats | null;
};

const StreamSettingsPopover = memo(
  ({
    volume,
    isMuted,
    onVolumeChange,
    onMuteToggle,
    buttonClassName,
    buttonSize = 'sm',
    streamStats
  }: TStreamSettingsPopoverProps) => {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <IconButton
            variant="ghost"
            icon={Settings}
            title="Stream Settings"
            size={buttonSize}
            className={cn(buttonClassName)}
          />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="bottom"
          className="w-56 p-3"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="space-y-3">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Volume
            </div>
            <div className="flex items-center gap-2">
              <IconButton
                variant="ghost"
                icon={isMuted ? VolumeX : Volume2}
                onClick={onMuteToggle}
                title={isMuted ? 'Unmute' : 'Mute'}
                size="sm"
                className={isMuted ? 'text-red-400' : ''}
              />
              <Slider
                value={[volume]}
                onValueChange={([value]) => onVolumeChange(value)}
                min={0}
                max={100}
                step={1}
                className="flex-1 cursor-pointer"
              />
              <span className="text-xs text-muted-foreground w-8 text-right">
                {Math.round(volume)}%
              </span>
            </div>
            {streamStats && (
              <>
                <div className="border-t border-border" />
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Stream Info
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <span className="text-muted-foreground">Resolution</span>
                  <span className="text-right font-medium">
                    {streamStats.width}×{streamStats.height}
                  </span>
                  {streamStats.frameRate !== null && (
                    <>
                      <span className="text-muted-foreground">Frame Rate</span>
                      <span className="text-right font-medium">
                        {Math.round(streamStats.frameRate)} fps
                      </span>
                    </>
                  )}
                  {streamStats.bitrate !== null && (
                    <>
                      <span className="text-muted-foreground">Bitrate</span>
                      <span className="text-right font-medium">
                        {streamStats.bitrate >= 1_000_000
                          ? `${(streamStats.bitrate / 1_000_000).toFixed(1)} Mbps`
                          : `${Math.round(streamStats.bitrate / 1000)} kbps`}
                      </span>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  }
);

StreamSettingsPopover.displayName = 'StreamSettingsPopover';

export { StreamSettingsPopover };
