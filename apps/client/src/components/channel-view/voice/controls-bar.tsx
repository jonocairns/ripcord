import { ChannelPermission } from '@sharkord/shared';
import {
	HeadphoneOff,
	Headphones,
	Mic,
	MicOff,
	Monitor,
	PhoneOff,
	ScreenShareOff,
	Video,
	VideoOff,
	X,
} from 'lucide-react';
import { memo, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useChannelCan } from '@/features/server/hooks';
import { leaveVoice } from '@/features/server/voice/actions';
import { useOwnVoiceState, useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import { ControlToggleButton } from './control-toggle-button';
import { VoiceSurface } from './voice-surface';

type TControlsBarProps = {
	channelId: number;
	onExitStage?: () => void;
};

const ControlsBar = memo(({ channelId, onExitStage }: TControlsBarProps) => {
	const { isStartingScreenShare, toggleMic, toggleSound, toggleWebcam, toggleScreenShare } = useVoice();
	const ownVoiceState = useOwnVoiceState();
	const channelCan = useChannelCan(channelId);

	const permissions = useMemo(
		() => ({
			canSpeak: channelCan(ChannelPermission.SPEAK),
			canWebcam: channelCan(ChannelPermission.WEBCAM),
			canShareScreen: channelCan(ChannelPermission.SHARE_SCREEN),
		}),
		[channelCan],
	);

	return (
		<div className={cn('pointer-events-none absolute inset-x-0 bottom-6 z-40 flex justify-center px-4')}>
			<VoiceSurface variant="controls" className="pointer-events-auto flex items-center gap-1 px-1.5 py-1.5">
				<ControlToggleButton
					enabled={ownVoiceState.micMuted}
					enabledLabel="Unmute"
					disabledLabel="Mute"
					enabledIcon={MicOff}
					disabledIcon={Mic}
					enabledClassName="border-destructive/20 bg-destructive/14 text-destructive hover:!border-destructive/20 hover:!bg-destructive/14 hover:!text-destructive"
					disabledClassName="text-white/75 hover:!border-white/10 hover:!bg-white/7 hover:!text-white"
					onClick={toggleMic}
					disabled={!permissions.canSpeak}
				/>

				<ControlToggleButton
					enabled={ownVoiceState.soundMuted}
					enabledLabel="Undeafen"
					disabledLabel="Deafen"
					enabledIcon={HeadphoneOff}
					disabledIcon={Headphones}
					enabledClassName="border-destructive/20 bg-destructive/14 text-destructive hover:!border-destructive/20 hover:!bg-destructive/14 hover:!text-destructive"
					disabledClassName="text-white/75 hover:!border-white/10 hover:!bg-white/7 hover:!text-white"
					onClick={toggleSound}
				/>

				<ControlToggleButton
					enabled={ownVoiceState.webcamEnabled}
					enabledLabel="Stop Video"
					disabledLabel="Start Video"
					enabledIcon={Video}
					disabledIcon={VideoOff}
					enabledClassName="border-live-video/25 bg-live-video/14 text-live-video hover:!border-live-video/25 hover:!bg-live-video/14 hover:!text-live-video"
					disabledClassName="text-white/75 hover:!border-white/10 hover:!bg-white/7 hover:!text-white"
					onClick={toggleWebcam}
					disabled={!permissions.canWebcam}
				/>

				<ControlToggleButton
					enabled={ownVoiceState.sharingScreen}
					enabledLabel="Stop Sharing"
					disabledLabel="Share Screen"
					enabledIcon={ScreenShareOff}
					disabledIcon={Monitor}
					enabledClassName="border-live-screen/25 bg-live-screen/14 text-live-screen hover:!border-live-screen/25 hover:!bg-live-screen/14 hover:!text-live-screen"
					disabledClassName="text-white/75 hover:!border-white/10 hover:!bg-white/7 hover:!text-white"
					loading={isStartingScreenShare}
					loadingLabel="Starting Screen Share"
					onClick={toggleScreenShare}
					disabled={!permissions.canShareScreen}
				/>

				<div className="mx-1 h-7 w-px bg-white/8" />

				<Tooltip content="Leave voice channel">
					<Button
						variant="ghost"
						size="icon"
						className={cn(
							'h-10 w-10 rounded-xl border border-destructive/20 bg-transparent text-destructive transition-[background-color,border-color,color,transform] duration-150 hover:!border-destructive/30 hover:!bg-destructive/10 hover:!text-destructive active:scale-95',
						)}
						onClick={leaveVoice}
						aria-label="Leave voice channel"
					>
						<PhoneOff size={20} strokeWidth={2.4} />
					</Button>
				</Tooltip>

				{onExitStage && (
					<Tooltip content="Exit stage">
						<Button
							variant="ghost"
							size="icon"
							className={cn(
								'h-10 w-10 rounded-xl border border-destructive/30 bg-destructive/20 text-destructive transition-[background-color,border-color,color,transform] duration-150 hover:!border-destructive/40 hover:!bg-destructive/30 hover:!text-destructive active:scale-95',
							)}
							onClick={onExitStage}
							aria-label="Exit stage"
						>
							<X size={18} strokeWidth={2.2} />
						</Button>
					</Tooltip>
				)}
			</VoiceSurface>
		</div>
	);
});

export { ControlsBar };
