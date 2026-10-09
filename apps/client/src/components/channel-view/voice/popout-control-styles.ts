import type { CSSProperties } from 'react';

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
	cursor: 'pointer',
};

const POPOUT_PANEL_STYLE: CSSProperties = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '8px',
	border: '1px solid rgba(255, 255, 255, 0.55)',
	background: 'rgba(15, 23, 42, 0.88)',
	borderRadius: '10px',
	padding: '4px 8px',
	boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
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
	justifyContent: 'center',
};

const POPOUT_ENABLE_AUDIO_BUTTON_STYLE: CSSProperties = {
	...POPOUT_BUTTON_STYLE,
	width: 'auto',
	padding: '0 12px',
	gap: '8px',
};

export { POPOUT_BUTTON_STYLE, POPOUT_ENABLE_AUDIO_BUTTON_STYLE, POPOUT_MUTE_BUTTON_STYLE, POPOUT_PANEL_STYLE };
