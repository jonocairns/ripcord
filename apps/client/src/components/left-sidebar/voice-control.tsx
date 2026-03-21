import { AlertTriangle, Loader2, LogOut, Wifi, WifiOff } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useChannelById, useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
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
	const { connectionStatus } = useVoice();

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
					text: 'Voice connected',
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
				<StatsPopover>
					<div className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-0.5">
						<div className={cn('flex h-8 w-8 items-center justify-center rounded-full', connectionInfo.iconBackground)}>
							{connectionInfo.icon}
						</div>
						<div className="min-w-0">
							<p className="truncate text-sm font-semibold text-foreground">{voiceChannel?.name ?? 'Voice Channel'}</p>
							<p className={cn('text-xs font-medium', connectionInfo.color)}>{connectionInfo.text}</p>
						</div>
					</div>
				</StatsPopover>

				<div className="flex items-center gap-1">
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
