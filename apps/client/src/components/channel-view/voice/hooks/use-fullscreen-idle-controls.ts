import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_IDLE_HIDE_MS = 2500;

type TFullscreenIdleControlsParams = {
	isFullscreen: boolean;
	idleHideMs?: number;
};

const useFullscreenIdleControls = ({
	isFullscreen,
	idleHideMs = DEFAULT_IDLE_HIDE_MS,
}: TFullscreenIdleControlsParams) => {
	const [showControls, setShowControls] = useState(true);
	const hideTimeoutRef = useRef<number | null>(null);

	// Live values read inside stable callbacks so reveal/track never go stale when
	// fullscreen toggles — every idle cycle re-arms the auto-hide the same way.
	const isFullscreenRef = useRef(isFullscreen);
	isFullscreenRef.current = isFullscreen;
	const idleHideMsRef = useRef(idleHideMs);
	idleHideMsRef.current = idleHideMs;

	const clearHideTimeout = useCallback(() => {
		if (hideTimeoutRef.current === null) {
			return;
		}

		window.clearTimeout(hideTimeoutRef.current);
		hideTimeoutRef.current = null;
	}, []);

	const revealControls = useCallback(() => {
		if (!isFullscreenRef.current) {
			return;
		}

		setShowControls(true);
		clearHideTimeout();

		hideTimeoutRef.current = window.setTimeout(() => {
			setShowControls(false);
			hideTimeoutRef.current = null;
		}, idleHideMsRef.current);
	}, [clearHideTimeout]);

	useEffect(() => {
		if (!isFullscreen) {
			clearHideTimeout();
			setShowControls(true);
			return;
		}

		revealControls();

		return clearHideTimeout;
	}, [isFullscreen, revealControls, clearHideTimeout]);

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
