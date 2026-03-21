import type { CSSProperties } from 'react';

type TSpeakingIndicatorStyle = CSSProperties & {
	'--speaking-active'?: string;
	'--speaking-level'?: string;
};

const MAX_SPEAKING_LEVEL = 36;
const SPEAKING_FLOOR = 8;

const getSpeakingIndicatorStyle = (audioLevel: number, isActive: boolean): TSpeakingIndicatorStyle => {
	const normalizedLevel = Math.max(
		0,
		Math.min(1, (audioLevel - SPEAKING_FLOOR) / (MAX_SPEAKING_LEVEL - SPEAKING_FLOOR)),
	);

	return {
		'--speaking-active': isActive ? '1' : '0',
		'--speaking-level': normalizedLevel.toFixed(3),
	};
};

export { getSpeakingIndicatorStyle };
