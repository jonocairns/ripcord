import { Button } from '@/components/ui/button';
import { leaveVoice } from '@/features/server/voice/actions';
import { useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  PhoneOff,
  Video,
  VideoOff
} from 'lucide-react';
import { memo } from 'react';

type TControlsProps = {
  className?: string;
};

const Controls = memo(({ className }: TControlsProps) => {
  const {
    ownVoiceState,
    toggleMic,
    toggleSound,
    toggleWebcam,
    toggleScreenShare
  } = useVoice();

  return (
    <div
      className={cn(
        'fixed bottom-6 left-1/2 transform -translate-x-1/2 z-50',
        'flex items-center gap-3 px-6 py-3',
        'bg-card/95 backdrop-blur-sm border border-border rounded-xl shadow-lg',
        className
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'h-12 w-12 rounded-xl',
          ownVoiceState.micMuted
            ? 'bg-red-500 hover:bg-red-600 text-white'
            : 'bg-primary/10 hover:bg-primary/20 text-primary'
        )}
        onClick={toggleMic}
        title={ownVoiceState.micMuted ? 'Unmute microphone' : 'Mute microphone'}
      >
        {ownVoiceState.micMuted ? (
          <MicOff className="h-5 w-5" />
        ) : (
          <Mic className="h-5 w-5" />
        )}
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'h-12 w-12 rounded-xl',
          ownVoiceState.soundMuted
            ? 'bg-red-500 hover:bg-red-600 text-white'
            : 'bg-primary/10 hover:bg-primary/20 text-primary'
        )}
        onClick={toggleSound}
        title={ownVoiceState.soundMuted ? 'Unmute sound' : 'Mute sound'}
      >
        {ownVoiceState.soundMuted ? (
          <HeadphoneOff className="h-5 w-5" />
        ) : (
          <Headphones className="h-5 w-5" />
        )}
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'h-12 w-12 rounded-xl',
          ownVoiceState.webcamEnabled
            ? 'bg-blue-500 hover:bg-blue-600 text-white'
            : 'bg-muted hover:bg-muted/80 text-muted-foreground'
        )}
        onClick={toggleWebcam}
        title={
          ownVoiceState.webcamEnabled ? 'Turn off camera' : 'Turn on camera'
        }
      >
        {ownVoiceState.webcamEnabled ? (
          <Video className="h-5 w-5" />
        ) : (
          <VideoOff className="h-5 w-5" />
        )}
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'h-12 w-12 rounded-xl',
          ownVoiceState.sharingScreen
            ? 'bg-purple-500 hover:bg-purple-600 text-white'
            : 'bg-muted hover:bg-muted/80 text-muted-foreground'
        )}
        onClick={toggleScreenShare}
        title={
          ownVoiceState.sharingScreen
            ? 'Stop screen share'
            : 'Start screen share'
        }
      >
        {ownVoiceState.sharingScreen ? (
          <Monitor className="h-5 w-5" />
        ) : (
          <MonitorOff className="h-5 w-5" />
        )}
      </Button>

      <div className="w-px h-8 bg-border mx-1" />

      <Button
        variant="ghost"
        size="icon"
        className="h-12 w-12 rounded-xl bg-red-500 hover:bg-red-600 text-white"
        onClick={leaveVoice}
        title="Leave meeting"
      >
        <PhoneOff className="h-5 w-5" />
      </Button>
    </div>
  );
});

export { Controls };
