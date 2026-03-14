import {
  useChannelById,
  useCurrentVoiceChannelId
} from '@/features/server/channels/hooks';
import { useChannelCan } from '@/features/server/hooks';
import { leaveVoice } from '@/features/server/voice/actions';
import { useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import { ChannelPermission } from '@sharkord/shared';
import {
  AlertTriangle,
  HeadphoneOff,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Wifi,
  WifiOff
} from 'lucide-react';
import { memo, useMemo } from 'react';
import { ExternalAudioStreams } from '../channel-view/voice/external-audio-streams';
import { VoiceAudioStreams } from '../channel-view/voice/voice-audio-streams';
import { Button } from '../ui/button';
import { StatsPopover } from './stats-popover';

const VoiceControl = memo(() => {
  const voiceChannelId = useCurrentVoiceChannelId();
  const voiceChannel = useChannelById(voiceChannelId ?? 0);
  const channelCan = useChannelCan(voiceChannelId);
  const { ownVoiceState, toggleMic, toggleSound, connectionStatus } =
    useVoice();

  const connectionInfo = useMemo(() => {
    switch (connectionStatus) {
      case 'connecting':
        return {
          icon: <Loader2 className="h-4 w-4 animate-spin" />,
          text: 'Connecting...',
          color: 'text-yellow-500'
        };
      case 'connected':
        return {
          icon: <Wifi className="h-4 w-4 text-green-600" />,
          text: 'Voice connected',
          color: 'text-green-600'
        };
      case 'failed':
        return {
          icon: <AlertTriangle className="h-4 w-4 text-red-500" />,
          text: 'Connection failed',
          color: 'text-red-500'
        };
      case 'disconnected':
      default:
        return {
          icon: <WifiOff className="h-4 w-4 text-red-500" />,
          text: 'Disconnected',
          color: 'text-red-500'
        };
    }
  }, [connectionStatus]);

  if (!voiceChannelId) {
    return null;
  }

  return (
    <>
      <VoiceAudioStreams channelId={voiceChannelId} />
      <ExternalAudioStreams channelId={voiceChannelId} />
      <div className="border-t border-border bg-secondary/20 px-2 py-2">
        <div className="flex items-center gap-3 px-1">
          <StatsPopover>
            <div className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
              {connectionInfo.icon}
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {voiceChannel?.name ?? 'Voice channel'}
                </span>
                <p
                  className={cn(
                    'truncate text-[11px] font-medium',
                    connectionInfo.color
                  )}
                >
                  {connectionInfo.text}
                </p>
              </div>
            </div>
          </StatsPopover>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-8 w-8 rounded-lg transition-all duration-200',
                ownVoiceState.micMuted
                  ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 hover:text-red-300'
                  : 'text-muted-foreground hover:bg-background/40 hover:text-foreground'
              )}
              onClick={toggleMic}
              title={
                ownVoiceState.micMuted
                  ? 'Unmute microphone (Ctrl+Shift+M)'
                  : 'Mute microphone (Ctrl+Shift+M)'
              }
              disabled={!channelCan(ChannelPermission.SPEAK)}
            >
              {ownVoiceState.micMuted ? (
                <MicOff className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-8 w-8 rounded-lg transition-all duration-200',
                ownVoiceState.soundMuted
                  ? 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 hover:text-amber-300'
                  : 'text-muted-foreground hover:bg-background/40 hover:text-foreground'
              )}
              onClick={toggleSound}
              title={
                ownVoiceState.soundMuted
                  ? 'Undeafen (Ctrl+Shift+D)'
                  : 'Deafen (Ctrl+Shift+D)'
              }
            >
              {ownVoiceState.soundMuted ? (
                <HeadphoneOff className="h-4 w-4" />
              ) : (
                <Headphones className="h-4 w-4" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-red-400 transition-all duration-200 hover:bg-red-500/20 hover:text-red-300"
              onClick={leaveVoice}
              title="Disconnect"
            >
              <PhoneOff className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </>
  );
});

export { VoiceControl };
