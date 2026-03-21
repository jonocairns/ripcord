import { HeadphoneOff, MicOff, Monitor, Video, Volume2, VolumeX } from 'lucide-react';
import { memo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { UserAvatar } from '@/components/user-avatar';
import type { TVoiceUser } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { useVoiceRefs } from '../channel-view/voice/hooks/use-voice-refs';
import { getSpeakingIndicatorStyle } from '../channel-view/voice/speaking-indicator';
import { Tooltip } from '../ui/tooltip';
import { UserPopover } from '../user-popover';
import { useVolumeControl } from '../voice-provider/volume-control-context';

type TVoiceUserProps = {
	user: TVoiceUser;
};

const VoiceUser = memo(({ user }: TVoiceUserProps) => {
	const { audioLevel, isSpeaking } = useVoiceRefs(user.id);
	const ownUserId = useOwnUserId();
	const { getUserVolumeKey, getVolume, setVolume, toggleMute } = useVolumeControl();
	const isOwnUser = user.id === ownUserId;
	const volumeKey = getUserVolumeKey(user.id);
	const volume = getVolume(volumeKey);
	const isMuted = volume === 0;
	const isActivelySpeaking = !user.state.micMuted && isSpeaking;
	const handleVolumeChange = useCallback(
		(values: number[]) => {
			setVolume(volumeKey, values[0] || 0);
		},
		[setVolume, volumeKey],
	);
	const handleToggleMute = useCallback(() => {
		toggleMute(volumeKey);
	}, [toggleMute, volumeKey]);
	const speakingStyle = getSpeakingIndicatorStyle(audioLevel, isActivelySpeaking);
	const hasStatusIndicators =
		user.state.micMuted || user.state.soundMuted || user.state.webcamEnabled || user.state.sharingScreen;

	return (
		<UserPopover
			userId={user.id}
			footer={
				!isOwnUser && (
					<div className="space-y-2">
						<p className="text-xs text-muted-foreground">Voice volume</p>
						<div className="flex items-center gap-2">
							<Button variant="ghost" size="sm" onClick={handleToggleMute} className="h-6 w-6 p-0">
								{isMuted ? <VolumeX className="h-4 w-4 text-muted-foreground" /> : <Volume2 className="h-4 w-4" />}
							</Button>
							<Slider
								value={[volume]}
								onValueChange={handleVolumeChange}
								min={0}
								max={100}
								step={1}
								className="flex-1 cursor-pointer"
							/>
							<span className="text-xs text-muted-foreground w-8 text-right">{volume}%</span>
						</div>
					</div>
				)
			}
		>
			<div className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-sm">
				<div className="speaking-avatar-shell" style={speakingStyle}>
					<UserAvatar
						userId={user.id}
						className={cn('relative z-[1] h-5 w-5 speaking-avatar-indicator')}
						showUserPopover={false}
						showStatusBadge={false}
					/>
				</div>

				<span className="flex-1 truncate text-sm text-foreground/80">{user.name}</span>

				{hasStatusIndicators && (
					<div className="flex items-center gap-2">
						{user.state.micMuted && (
							<Tooltip content="Mic muted">
								<span className="inline-flex">
									<MicOff className="h-3.5 w-3.5 text-red-400" />
								</span>
							</Tooltip>
						)}
						{user.state.soundMuted && (
							<Tooltip content="Deafened">
								<span className="inline-flex">
									<HeadphoneOff className="h-3.5 w-3.5 text-red-400" />
								</span>
							</Tooltip>
						)}
						{user.state.webcamEnabled && (
							<Tooltip content="Camera on">
								<span className="inline-flex">
									<Video className="sidebar-live-indicator sidebar-live-indicator--video h-3.5 w-3.5 text-sky-400" />
								</span>
							</Tooltip>
						)}
						{user.state.sharingScreen && (
							<Tooltip content="Sharing screen">
								<span className="inline-flex">
									<Monitor className="sidebar-live-indicator sidebar-live-indicator--screen h-3.5 w-3.5 text-fuchsia-400" />
								</span>
							</Tooltip>
						)}
					</div>
				)}
			</div>
		</UserPopover>
	);
});

export { VoiceUser };
