type TWindowState = {
	width: number;
	height: number;
};

const isFiniteNumber = (value: unknown): value is number => {
	return typeof value === 'number' && Number.isFinite(value);
};

const parseWindowState = (value: unknown): TWindowState | undefined => {
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

const resolveInitialWindowSize = (
	saved: TWindowState | undefined,
	workAreaSize: TWindowState,
	minimumSize: TWindowState,
): TWindowState => {
	const clamp = (size: number, minimum: number, available: number) => {
		return Math.max(minimum, Math.min(size, available));
	};

	return {
		width: clamp(saved?.width ?? minimumSize.width, minimumSize.width, workAreaSize.width),
		height: clamp(saved?.height ?? minimumSize.height, minimumSize.height, workAreaSize.height),
	};
};

export type { TWindowState };
export { parseWindowState, resolveInitialWindowSize };
