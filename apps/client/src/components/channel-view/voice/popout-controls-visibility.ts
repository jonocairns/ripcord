type TPopoutControlsVisibilityOptions = {
	setVisible: (visible: boolean) => void;
	isInteracting: () => boolean;
	scheduleHide: (callback: () => void) => () => void;
};

const createPopoutControlsVisibility = ({
	setVisible,
	isInteracting,
	scheduleHide,
}: TPopoutControlsVisibilityOptions) => {
	let cancelHide: (() => void) | undefined;
	let disposed = false;

	const reveal = () => {
		if (disposed) return;
		cancelHide?.();
		setVisible(true);
		cancelHide = scheduleHide(() => {
			cancelHide = undefined;
			if (!disposed && !isInteracting()) {
				setVisible(false);
			}
		});
	};

	const dispose = () => {
		disposed = true;
		cancelHide?.();
		cancelHide = undefined;
	};

	return { reveal, dispose };
};

export { createPopoutControlsVisibility };
