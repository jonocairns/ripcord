import { Volume2, VolumeX } from 'lucide-react';
import { type ChangeEvent, memo } from 'react';
import { POPOUT_MUTE_BUTTON_STYLE, POPOUT_PANEL_STYLE } from './popout-control-styles';

type TPopoutVolumePanelProps = {
	volume: number;
	isMuted: boolean;
	onMuteToggle: () => void;
	onVolumeChange: (e: ChangeEvent<HTMLInputElement>) => void;
};

const PopoutVolumePanel = memo(({ volume, isMuted, onMuteToggle, onVolumeChange }: TPopoutVolumePanelProps) => {
	return (
		<div style={POPOUT_PANEL_STYLE}>
			<button
				type="button"
				onClick={onMuteToggle}
				title={isMuted ? 'Unmute stream audio' : 'Mute stream audio'}
				aria-label={isMuted ? 'Unmute stream audio' : 'Mute stream audio'}
				style={POPOUT_MUTE_BUTTON_STYLE}
			>
				{isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
			</button>
			<input
				type="range"
				min={0}
				max={100}
				step={1}
				value={volume}
				onChange={onVolumeChange}
				aria-label="Pop-out volume"
				style={{ width: '96px', cursor: 'pointer' }}
			/>
			<span
				style={{
					width: '34px',
					textAlign: 'right',
					fontSize: '12px',
					opacity: 0.85,
				}}
			>
				{volume}%
			</span>
		</div>
	);
});

PopoutVolumePanel.displayName = 'PopoutVolumePanel';

export { PopoutVolumePanel };
