import { ChannelPermission } from '@sharkord/shared';
import { AlertTriangle, Loader2, LogOut, Monitor, ScreenShareOff, Video, VideoOff, Wifi, WifiOff } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useChannelById, useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useChannelCan } from '@/features/server/hooks';
import { leaveVoice } from '@/features/server/voice/actions';
import { useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import { ExternalAudioStreams } from '../channel-view/voice/external-audio-streams';
import { VoiceAudioStreams } from '../channel-view/voice/voice-audio-streams';
import { Button } from '../ui/button';
import { StatsPopover } from './stats-popover';

const VoiceControl = memo(() => {
	const voiceChannelId = useCurrentVoiceChannelId();
	const voiceChannel = useChannelById(voiceChannelId ?? -1);
	const channelCan = useChannelCan(voiceChannelId);
	const { connectionStatus, ownVoiceState, toggleScreenShare, toggleWebcam } = useVoice();

	const connectionInfo = useMemo(() => {
		switch (connectionStatus) {
			case 'connecting':
				return {
					icon: <Loader2 className="h-4 w-4 animate-spin" />,
					text: 'Connecting...',
					color: 'text-yellow-500',
					iconBackground: 'bg-yellow-500/10',
				};
			case 'connected':
				return {
					icon: <Wifi className="h-4 w-4 text-green-600" />,
					text: 'Connected',
					color: 'text-green-600',
					iconBackground: 'bg-emerald-500/10',
				};
			case 'failed':
				return {
					icon: <AlertTriangle className="h-4 w-4 text-red-500" />,
					text: 'Connection failed',
					color: 'text-red-500',
					iconBackground: 'bg-red-500/10',
				};
			case 'disconnected':
			default:
				return {
					icon: <WifiOff className="h-4 w-4 text-red-500" />,
					text: 'Disconnected',
					color: 'text-red-500',
					iconBackground: 'bg-red-500/10',
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
			<div className="flex items-center justify-between gap-3 px-3 py-3">
				<StatsPopover triggerClassName="min-w-0 flex-1">
					<div className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-0.5">
						<div className={cn('flex h-8 w-8 items-center justify-center rounded-full', connectionInfo.iconBackground)}>
							{connectionInfo.icon}
						</div>
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm font-semibold text-foreground">{voiceChannel?.name ?? 'Voice Channel'}</p>
							<p className={cn('truncate text-xs font-medium', connectionInfo.color)}>{connectionInfo.text}</p>
						</div>
					</div>
				</StatsPopover>

				<div className="flex shrink-0 items-center gap-1">
					<Button
						variant="ghost"
						size="icon"
						className={cn(
							'h-8 w-8 rounded-lg text-muted-foreground transition-colors hover:!bg-white/6 hover:!text-white',
							ownVoiceState.webcamEnabled &&
								'bg-emerald-500/12 text-emerald-300 hover:!bg-emerald-500/12 hover:!text-emerald-300',
						)}
						onClick={toggleWebcam}
						title={ownVoiceState.webcamEnabled ? 'Stop video' : 'Start video'}
						disabled={!channelCan(ChannelPermission.WEBCAM)}
					>
						{ownVoiceState.webcamEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
					</Button>

					<Button
						variant="ghost"
						size="icon"
						className={cn(
							'h-8 w-8 rounded-lg text-muted-foreground transition-colors hover:!bg-white/6 hover:!text-white',
							ownVoiceState.sharingScreen && 'bg-sky-500/12 text-sky-300 hover:!bg-sky-500/12 hover:!text-sky-300',
						)}
						onClick={toggleScreenShare}
						title={ownVoiceState.sharingScreen ? 'Stop sharing' : 'Share screen'}
						disabled={!channelCan(ChannelPermission.SHARE_SCREEN)}
					>
						{ownVoiceState.sharingScreen ? <ScreenShareOff className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
					</Button>

					<Button
						variant="ghost"
						size="icon"
						className="h-8 w-8 rounded-lg text-red-400 transition-colors hover:!bg-red-500/10 hover:!text-red-300"
						onClick={leaveVoice}
						title="Leave voice"
					>
						<LogOut className="h-4 w-4" />
					</Button>
				</div>
			</div>
		</>
	);
});

export { VoiceControl };
