import { Resolution } from '@/types';

// Selectable framerate options (fps) shown in the resolution/fps control.
const FRAMERATE_OPTIONS = [5, 10, 15, 24, 30, 60, 120] as const;

// Highest framerate we allow per resolution. 4K is capped at 30fps: 4K60 is
// rough to encode well even on hardware, and worse, every viewer must decode
// 4K60 (stutters on all but strong hardware). For smooth 60fps, 1440p60 is the
// right trade. Above 4K we only strip the physically-unencodable combos.
const MAX_FRAMERATE_BY_RESOLUTION: Record<Resolution, number> = {
	[Resolution['2160p']]: 30,
	[Resolution['1440p']]: 60,
	[Resolution['1080p']]: 120,
	[Resolution['720p']]: 120,
	[Resolution['480p']]: 120,
	[Resolution['360p']]: 120,
	[Resolution['240p']]: 120,
	[Resolution['144p']]: 120,
};

const DEFAULT_MAX_FRAMERATE = 120;

const getMaxFramerateForResolution = (resolution: Resolution): number => {
	return MAX_FRAMERATE_BY_RESOLUTION[resolution] ?? DEFAULT_MAX_FRAMERATE;
};

// Framerate options valid for the given resolution (those at or below its cap).
const getAvailableFramerates = (resolution: Resolution): number[] => {
	const max = getMaxFramerateForResolution(resolution);

	return FRAMERATE_OPTIONS.filter((fps) => fps <= max);
};

// Clamp a framerate to the highest value allowed for the resolution. Because the
// caps (60/120) are themselves valid options, the result is always selectable.
const clampFramerateToResolution = (resolution: Resolution, framerate: number): number => {
	return Math.min(framerate, getMaxFramerateForResolution(resolution));
};

export {
	clampFramerateToResolution,
	FRAMERATE_OPTIONS,
	getAvailableFramerates,
	getMaxFramerateForResolution,
};
