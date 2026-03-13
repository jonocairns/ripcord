import { Maximize2, Minimize2, Volume2, VolumeX } from 'lucide-react';
import {
  memo,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode
} from 'react';

const POPOUT_BUTTON_STYLE: CSSProperties = {
  border: '1px solid rgba(255, 255, 255, 0.55)',
  background: 'rgba(15, 23, 42, 0.88)',
  color: '#ffffff',
  borderRadius: '10px',
  width: '40px',
  height: '40px',
  padding: '0',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
  cursor: 'pointer'
};

const POPOUT_PANEL_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  border: '1px solid rgba(255, 255, 255, 0.55)',
  background: 'rgba(15, 23, 42, 0.88)',
  borderRadius: '10px',
  padding: '4px 8px',
  boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)'
};

const POPOUT_MUTE_BUTTON_STYLE: CSSProperties = {
  border: '1px solid rgba(255, 255, 255, 0.55)',
  background: 'rgba(15, 23, 42, 0.88)',
  color: '#ffffff',
  borderRadius: '8px',
  width: '32px',
  height: '32px',
  padding: '0',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center'
};

const POPOUT_ENABLE_AUDIO_BUTTON_STYLE: CSSProperties = {
  ...POPOUT_BUTTON_STYLE,
  width: 'auto',
  padding: '0 12px',
  gap: '8px'
};

type TPopoutWindowControlsProps = {
  visible: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  children?: ReactNode;
};

const PopoutWindowControls = memo(
  ({
    visible,
    isFullscreen,
    onToggleFullscreen,
    children
  }: TPopoutWindowControlsProps) => {
    return (
      <div
        style={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? 'auto' : 'none',
          transition: 'opacity 140ms ease'
        }}
      >
        {children}
        <button
          type="button"
          onClick={onToggleFullscreen}
          title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          style={POPOUT_BUTTON_STYLE}
        >
          {isFullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
        </button>
      </div>
    );
  }
);

PopoutWindowControls.displayName = 'PopoutWindowControls';

type TPopoutVolumePanelProps = {
  volume: number;
  isMuted: boolean;
  onMuteToggle: () => void;
  onVolumeChange: (e: ChangeEvent<HTMLInputElement>) => void;
};

const PopoutVolumePanel = memo(
  ({
    volume,
    isMuted,
    onMuteToggle,
    onVolumeChange
  }: TPopoutVolumePanelProps) => {
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
            opacity: 0.85
          }}
        >
          {volume}%
        </span>
      </div>
    );
  }
);

PopoutVolumePanel.displayName = 'PopoutVolumePanel';

export {
  POPOUT_BUTTON_STYLE,
  POPOUT_ENABLE_AUDIO_BUTTON_STYLE,
  PopoutVolumePanel,
  PopoutWindowControls
};
