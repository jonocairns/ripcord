type TWindowSize = {
	width: number;
	height: number;
};

const isFiniteNumber = (value: unknown): value is number => {
	return typeof value === 'number' && Number.isFinite(value);
};

const parseWindowSize = (value: unknown): TWindowSize | undefined => {
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const width = 'width' in value ? value.width : undefined;
	const height = 'height' in value ? value.height : undefined;

	if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
		return undefined;
	}

	return {
		width: Math.round(width),
		height: Math.round(height),
	};
};

const resolveWindowSizing = (
	saved: TWindowSize | undefined,
	workAreaSize: TWindowSize,
	configuredMinimumSize: TWindowSize,
) => {
	const minimumSize = {
		width: Math.min(configuredMinimumSize.width, workAreaSize.width),
		height: Math.min(configuredMinimumSize.height, workAreaSize.height),
	};
	const clamp = (size: number, minimum: number, available: number) => {
		return Math.max(minimum, Math.min(size, available));
	};

	return {
		minimumSize,
		initialSize: {
			width: clamp(saved?.width ?? minimumSize.width, minimumSize.width, workAreaSize.width),
			height: clamp(saved?.height ?? minimumSize.height, minimumSize.height, workAreaSize.height),
		},
	};
};

export type { TWindowSize };
export { parseWindowSize, resolveWindowSizing };
