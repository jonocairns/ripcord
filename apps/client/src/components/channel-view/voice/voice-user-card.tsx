import { EyeOff, HeadphoneOff, MicOff, Monitor, Video } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import { IconButton } from '@/components/ui/icon-button';
import { UserAvatar } from '@/components/user-avatar';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import type { TVoiceUser } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { CardControls } from './card-controls';
import { useVoiceRefs } from './hooks/use-voice-refs';
import { PinButton } from './pin-button';
import { VoiceSurface } from './voice-surface';
import { VolumeButton } from './volume-button';

type TVoiceUserCardProps = {
	userId: number;
	onPin: () => void;
	onUnpin: () => void;
	showPinControls?: boolean;
	voiceUser: TVoiceUser;
	className?: string;
	isPinned?: boolean;
	onStopWatching?: () => void;
};

const VoiceUserCard = memo(
	({
		userId,
		onPin,
		onUnpin,
		className,
		isPinned = false,
		showPinControls = true,
		voiceUser,
		onStopWatching,
	}: TVoiceUserCardProps) => {
		const { videoRef, hasVideoStream, isSpeaking, speakingIntensity } = useVoiceRefs(userId);
		const { getUserVolumeKey } = useVolumeControl();
		const { devices } = useDevices();
		const ownUserId = useOwnUserId();
		const isOwnUser = userId === ownUserId;

		const handlePinToggle = useCallback(() => {
			if (isPinned) {
				onUnpin?.();
			} else {
				onPin?.();
			}
		}, [isPinned, onPin, onUnpin]);

		const isActivelySpeaking = !voiceUser.state.micMuted && isSpeaking;

		return (
			<VoiceSurface
				className={cn(
					'relative group',
					'flex items-center justify-center',
					'w-full h-full',
					isActivelySpeaking
						? speakingIntensity === 1
							? 'speaking-effect-low'
							: speakingIntensity === 2
								? 'speaking-effect-medium'
								: 'speaking-effect-high'
						: '',
					className,
				)}
			>
				<CardControls>
					{!isOwnUser && hasVideoStream && onStopWatching && (
						<IconButton variant="ghost" icon={EyeOff} onClick={onStopWatching} title="Stop Watching" size="default" />
					)}
					{!isOwnUser && <VolumeButton volumeKey={getUserVolumeKey(userId)} />}
					{showPinControls && <PinButton isPinned={isPinned} handlePinToggle={handlePinToggle} />}
				</CardControls>

				{hasVideoStream && (
					<video
						ref={videoRef}
						autoPlay
						muted
						playsInline
						className={cn(
							'absolute inset-0 h-full w-full bg-black/40 object-contain',
							isOwnUser && devices.mirrorOwnVideo && '-scale-x-100',
						)}
					/>
				)}
				{!hasVideoStream && (
					<UserAvatar
						userId={userId}
						className="h-20 w-20 md:h-24 md:w-24 lg:h-28 lg:w-28"
						fallbackClassName="text-2xl md:text-3xl lg:text-4xl"
						showStatusBadge={false}
					/>
				)}

				<div className="absolute bottom-0 left-0 right-0 p-3 z-10 opacity-0 transition-opacity group-hover:opacity-100">
					<div className="inline-flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-black/45 px-2.5 py-1.5 shadow-sm backdrop-blur-md">
						<span className="min-w-0 truncate text-xs font-medium text-white">{voiceUser.name}</span>
						{(voiceUser.state.micMuted ||
							voiceUser.state.soundMuted ||
							voiceUser.state.webcamEnabled ||
							voiceUser.state.sharingScreen) && (
							<div className="ml-auto flex items-center gap-1">
								{voiceUser.state.micMuted && <MicOff className="size-3.5 text-red-500/80" />}
								{voiceUser.state.soundMuted && <HeadphoneOff className="size-3.5 text-red-500/80" />}
								{voiceUser.state.webcamEnabled && <Video className="size-3.5 text-sky-400/90" />}
								{voiceUser.state.sharingScreen && <Monitor className="size-3.5 text-cyan-400/90" />}
							</div>
						)}
					</div>
				</div>
			</VoiceSurface>
		);
	},
);

VoiceUserCard.displayName = 'VoiceUserCard';

export { VoiceUserCard };
