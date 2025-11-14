import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { leaveVoice } from '@/features/server/voice/actions';
import { useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import { Monitor, MonitorOff, Video, VideoOff } from 'lucide-react';
import { memo } from 'react';
import { Button } from '../ui/button';

const VoiceControl = memo(() => {
  const voiceChannelId = useCurrentVoiceChannelId();
  const { ownVoiceState, toggleWebcam, toggleScreenShare } = useVoice();

  if (!voiceChannelId) {
    return null;
  }

  return (
    <div className="flex items-center justify-between h-14 px-2 bg-muted/20 border-t border-border">
      <Button variant="ghost" onClick={leaveVoice}>
        Disconnect
      </Button>

      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8 hover:bg-muted/50',
            ownVoiceState.webcamEnabled
              ? 'text-blue-500 hover:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={toggleWebcam}
          title={
            ownVoiceState.webcamEnabled ? 'Turn off camera' : 'Turn on camera'
          }
        >
          {ownVoiceState.webcamEnabled ? (
            <Video className="h-4 w-4" />
          ) : (
            <VideoOff className="h-4 w-4" />
          )}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8 hover:bg-muted/50',
            ownVoiceState.sharingScreen
              ? 'text-purple-500 hover:text-purple-400 bg-purple-500/10 hover:bg-purple-500/20'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={toggleScreenShare}
          title={
            ownVoiceState.sharingScreen
              ? 'Stop screen share'
              : 'Start screen share'
          }
        >
          {ownVoiceState.sharingScreen ? (
            <Monitor className="h-4 w-4" />
          ) : (
            <MonitorOff className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
});

export { VoiceControl };
