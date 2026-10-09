import { Volume2, VolumeX } from 'lucide-react';
import { type ChangeEvent, memo } from 'react';

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

export { PopoutVolumePanel };
