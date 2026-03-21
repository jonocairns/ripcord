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
} from 'lucide-react';
import { memo, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { useChannelCan } from '@/features/server/hooks';
import { leaveVoice } from '@/features/server/voice/actions';
import { useOwnVoiceState, useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import { ControlToggleButton } from './control-toggle-button';
import { VoiceSurface } from './voice-surface';

type TControlsBarProps = {
	channelId: number;
};

const ControlsBar = memo(({ channelId }: TControlsBarProps) => {
	const { toggleMic, toggleSound, toggleWebcam, toggleScreenShare } = useVoice();
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
		<div className={cn('pointer-events-none absolute inset-x-0 bottom-6 z-50 flex justify-center px-4')}>
			<VoiceSurface variant="controls" className="pointer-events-auto flex items-center gap-0.5 px-1.5 py-1.5">
				<ControlToggleButton
					enabled={ownVoiceState.micMuted}
					enabledLabel="Unmute"
					disabledLabel="Mute"
					enabledIcon={MicOff}
					disabledIcon={Mic}
					enabledClassName="border-red-400/20 bg-red-500/14 text-red-200 hover:!border-red-400/20 hover:!bg-red-500/14 hover:!text-red-200"
					disabledClassName="text-slate-300 hover:!border-white/10 hover:!bg-white/7 hover:!text-white"
					onClick={toggleMic}
					disabled={!permissions.canSpeak}
				/>

				<ControlToggleButton
					enabled={ownVoiceState.soundMuted}
					enabledLabel="Undeafen"
					disabledLabel="Deafen"
					enabledIcon={HeadphoneOff}
					disabledIcon={Headphones}
					enabledClassName="border-red-400/20 bg-red-500/14 text-red-200 hover:!border-red-400/20 hover:!bg-red-500/14 hover:!text-red-200"
					disabledClassName="text-slate-300 hover:!border-white/10 hover:!bg-white/7 hover:!text-white"
					onClick={toggleSound}
				/>

				<ControlToggleButton
					enabled={ownVoiceState.webcamEnabled}
					enabledLabel="Stop Video"
					disabledLabel="Start Video"
					enabledIcon={Video}
					disabledIcon={VideoOff}
					enabledClassName="border-emerald-400/20 bg-emerald-500/14 text-emerald-200 hover:!border-emerald-400/20 hover:!bg-emerald-500/14 hover:!text-emerald-200"
					disabledClassName="text-slate-300 hover:!border-white/10 hover:!bg-white/7 hover:!text-white"
					onClick={toggleWebcam}
					disabled={!permissions.canWebcam}
				/>

				<ControlToggleButton
					enabled={ownVoiceState.sharingScreen}
					enabledLabel="Stop Sharing"
					disabledLabel="Share Screen"
					enabledIcon={ScreenShareOff}
					disabledIcon={Monitor}
					enabledClassName="border-sky-400/20 bg-sky-500/14 text-sky-200 hover:!border-sky-400/20 hover:!bg-sky-500/14 hover:!text-sky-200"
					disabledClassName="text-slate-300 hover:!border-white/10 hover:!bg-white/7 hover:!text-white"
					onClick={toggleScreenShare}
					disabled={!permissions.canShareScreen}
				/>

				<div className="mx-0.5 h-7 w-px bg-white/8" />

				<Button
					variant="ghost"
					size="icon"
					className={cn(
						'h-10 w-10 rounded-xl border border-red-300/15 bg-[#ef4444] text-white transition-[background-color,border-color,transform] duration-150 hover:!border-red-200/30 hover:!bg-[#dc2626] hover:!text-white active:scale-95',
					)}
					onClick={leaveVoice}
					aria-label="Disconnect"
				>
					<PhoneOff size={20} strokeWidth={2.4} />
				</Button>
			</VoiceSurface>
		</div>
	);
});

export { ControlsBar };
