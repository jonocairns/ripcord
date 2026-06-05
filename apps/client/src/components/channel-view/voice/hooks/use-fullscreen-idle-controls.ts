import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_IDLE_HIDE_MS = 2500;

type TFullscreenIdleControlsParams = {
	isFullscreen: boolean;
	idleHideMs?: number;
};

const useFullscreenIdleControls = ({ isFullscreen, idleHideMs = DEFAULT_IDLE_HIDE_MS }: TFullscreenIdleControlsParams) => {
	const [showControls, setShowControls] = useState(true);
	const hideControlsTimeoutRef = useRef<number | null>(null);

	const clearHideControlsTimeout = useCallback(() => {
		if (hideControlsTimeoutRef.current === null) {
			return;
		}

		window.clearTimeout(hideControlsTimeoutRef.current);
		hideControlsTimeoutRef.current = null;
	}, []);

	const revealControls = useCallback(() => {
		if (!isFullscreen) {
			return;
		}

		setShowControls(true);
		clearHideControlsTimeout();

		hideControlsTimeoutRef.current = window.setTimeout(() => {
			setShowControls(false);
			hideControlsTimeoutRef.current = null;
		}, idleHideMs);
	}, [clearHideControlsTimeout, idleHideMs, isFullscreen]);

	useEffect(() => {
		if (!isFullscreen) {
			clearHideControlsTimeout();
			setShowControls(true);
			return;
		}

		revealControls();
	}, [clearHideControlsTimeout, isFullscreen, revealControls]);

	useEffect(() => {
		return () => {
			clearHideControlsTimeout();
		};
	}, [clearHideControlsTimeout]);

	// Wraps a pointer handler so any cursor activity reveals (and re-arms the auto-hide of) the controls.
	const trackPointerActivity = useCallback(
		(handler?: (event: MouseEvent) => void) => (event: MouseEvent) => {
			revealControls();
			handler?.(event);
		},
		[revealControls],
	);

	return {
		// `undefined` outside fullscreen lets CardControls fall back to its default hover behavior.
		controlsVisible: isFullscreen ? showControls : undefined,
		trackPointerActivity,
	};
};

export { useFullscreenIdleControls };
