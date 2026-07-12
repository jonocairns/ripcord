import { ChannelPermission } from '@sharkord/shared';
import { AlertTriangle, Loader2, LogOut, Monitor, ScreenShareOff, Video, VideoOff, Wifi, WifiOff } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useChannelById, useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useChannelCan } from '@/features/server/hooks';
import { leaveVoice } from '@/features/server/voice/actions';
import { useVoice } from '@/features/server/voice/hooks';
import {
	getVoiceReconnectIndicatorDelayMs,
	shouldShowVoiceReconnectIndicator,
} from '@/features/server/voice/reconnect-indicator';
import { useVoiceSessionSelector } from '@/features/server/voice/voice-session-hooks';
import { selectReconnectingSince } from '@/features/server/voice/voice-session-machine';
import { cn } from '@/lib/utils';
import { ExternalAudioStreams } from '../channel-view/voice/external-audio-streams';
import { VoiceAudioStreams } from '../channel-view/voice/voice-audio-streams';
import { Button } from '../ui/button';
import { StatsPopover } from './stats-popover';

const VoiceControl = memo(() => {
	const voiceChannelId = useCurrentVoiceChannelId();
	const voiceChannel = useChannelById(voiceChannelId ?? -1);
	const channelCan = useChannelCan(voiceChannelId);
	const { connectionStatus, isStartingScreenShare, ownVoiceState, toggleScreenShare, toggleWebcam } = useVoice();
	const reconnectingSince = useVoiceSessionSelector(selectReconnectingSince);
	const [showReconnectIndicator, setShowReconnectIndicator] = useState(() =>
		shouldShowVoiceReconnectIndicator(voiceChannelId, reconnectingSince),
	);

	useEffect(() => {
		if (voiceChannelId !== undefined || reconnectingSince === undefined) {
			setShowReconnectIndicator(false);
			return;
		}

		const delayMs = getVoiceReconnectIndicatorDelayMs(reconnectingSince);

		if (delayMs === 0) {
			setShowReconnectIndicator(true);
			return;
		}

		setShowReconnectIndicator(false);

		const timeoutId = window.setTimeout(() => {
			setShowReconnectIndicator(true);
		}, delayMs);

		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [voiceChannelId, reconnectingSince]);

	const connectionInfo = useMemo(() => {
		switch (connectionStatus) {
			case 'connecting':
				return {
					icon: <Loader2 className="h-4 w-4 animate-spin" />,
					text: 'Connecting...',
					color: 'text-warning',
					iconBackground: 'bg-warning/10',
				};
			case 'connected':
				return {
					icon: <Wifi className="h-4 w-4 text-success" />,
					text: 'Connected',
					color: 'text-success',
					iconBackground: 'bg-success/10',
				};
			case 'failed':
				return {
					icon: <AlertTriangle className="h-4 w-4 text-destructive" />,
					text: 'Connection failed',
					color: 'text-destructive',
					iconBackground: 'bg-destructive/10',
				};
			case 'disconnected':
			default:
				return {
					icon: <WifiOff className="h-4 w-4 text-destructive" />,
					text: 'Disconnected',
					color: 'text-destructive',
					iconBackground: 'bg-destructive/10',
				};
		}
	}, [connectionStatus]);

	if (voiceChannelId === undefined) {
		if (!showReconnectIndicator) {
			return null;
		}

		return (
			<div className="px-3 py-3 animate-in fade-in duration-200">
				<div className="flex items-center gap-3 rounded-md border border-warning/20 bg-warning/10 px-3 py-2.5">
					<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/12">
						<Loader2 className="h-4 w-4 animate-spin text-warning" />
					</div>
					<div className="min-w-0 flex-1">
						<p className="truncate text-sm font-semibold text-foreground">Reconnecting voice...</p>
						<p className="truncate text-xs text-warning/90">Trying to restore your channel.</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<>
			<VoiceAudioStreams channelId={voiceChannelId} />
			<ExternalAudioStreams channelId={voiceChannelId} />
			<div className="flex items-center justify-between gap-3 border-b border-white/6 px-3 py-3">
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
								'bg-live-video/14 text-live-video hover:!bg-live-video/14 hover:!text-live-video',
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
							(ownVoiceState.sharingScreen || isStartingScreenShare) &&
								'bg-live-screen/14 text-live-screen ring-1 ring-live-screen/15 hover:!bg-live-screen/14 hover:!text-live-screen',
						)}
						onClick={toggleScreenShare}
						title={
							isStartingScreenShare
								? 'Starting screen share...'
								: ownVoiceState.sharingScreen
									? 'Stop sharing'
									: 'Share screen'
						}
						disabled={!channelCan(ChannelPermission.SHARE_SCREEN)}
					>
						{isStartingScreenShare ? (
							<Loader2 className="h-4 w-4 animate-spin text-live-screen" />
						) : ownVoiceState.sharingScreen ? (
							<ScreenShareOff className="h-4 w-4" />
						) : (
							<Monitor className="h-4 w-4" />
						)}
					</Button>

					<Button
						variant="ghost"
						size="icon"
						className="h-8 w-8 rounded-lg text-destructive transition-colors hover:!bg-destructive/10 hover:!text-destructive"
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
