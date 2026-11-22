import { Volume2, VolumeX } from 'lucide-react';
import { type ChangeEvent, memo } from 'react';
import { SCREEN_AUDIO_STATUS_LABELS, type TScreenAudioStatus } from './screen-audio-status';

type TPopoutVolumePanelProps = {
	volume: number;
	isMuted: boolean;
	onMuteToggle: () => void;
	onVolumeChange: (e: ChangeEvent<HTMLInputElement>) => void;
};

const PopoutVolumePanel = memo(({ volume, isMuted, onMuteToggle, onVolumeChange }: TPopoutVolumePanelProps) => {
	return (
		<div className="ripcord-popout-volume-panel">
			<button
				type="button"
				onClick={onMuteToggle}
				title={isMuted ? 'Unmute stream audio' : 'Mute stream audio'}
				aria-label={isMuted ? 'Unmute stream audio' : 'Mute stream audio'}
				className="ripcord-popout-button ripcord-popout-small-button"
			>
				{isMuted ? <VolumeX size={14} strokeWidth={1.5} /> : <Volume2 size={14} strokeWidth={1.5} />}
			</button>
			<input
				type="range"
				min={0}
				max={100}
				step={1}
				value={volume}
				onChange={onVolumeChange}
				aria-label="Pop-out volume"
			/>
			<span>{volume}%</span>
		</div>
	);
});

PopoutVolumePanel.displayName = 'PopoutVolumePanel';

type TPopoutAudioUnavailableProps = {
	status: Exclude<TScreenAudioStatus, 'live'>;
	onRetry?: () => void;
};

// Stands in for the volume panel when there is no stream audio to control, so
// the bar says why instead of leaving the slot empty. While audio is pending
// or failed it doubles as the retry button, the pop-out's only way to recover.
const PopoutAudioUnavailable = memo(({ status, onRetry }: TPopoutAudioUnavailableProps) => {
	const label = SCREEN_AUDIO_STATUS_LABELS[status];

	if (onRetry && (status === 'connecting' || status === 'failed')) {
		const title = `${label}. Retry`;
		return (
			<button
				type="button"
				onClick={onRetry}
				title={title}
				aria-label={title}
				data-status={status}
				className="ripcord-popout-button ripcord-popout-audio-retry"
			>
				<VolumeX size={14} strokeWidth={1.5} />
			</button>
		);
	}

	return (
		<span className="ripcord-popout-audio-unavailable" role="img" title={label} aria-label={label}>
			<VolumeX size={14} strokeWidth={1.5} />
		</span>
	);
});

PopoutAudioUnavailable.displayName = 'PopoutAudioUnavailable';

export { PopoutAudioUnavailable, PopoutVolumePanel };
