import { useEffect, useState } from 'react';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { createPopoutControlsVisibility } from '../popout-controls-visibility';

const IDLE_HIDE_MS = 1500;

const usePopoutControlsVisibility = (windowName: string) => {
	const [controlsElement, setControlsElement] = useState<HTMLElement | null>(null);
	const [visible, setVisible] = useState(true);

	useEffect(() => {
		const popoutWindow = controlsElement?.ownerDocument.defaultView;
		const surface = controlsElement?.closest('.ripcord-popout-surface');
		if (!controlsElement || !popoutWindow || !surface) return;

		const visibility = createPopoutControlsVisibility({
			setVisible,
			isInteracting: () => controlsElement.matches(':hover, :focus-within'),
			scheduleHide: (callback) => {
				const timer = popoutWindow.setTimeout(callback, IDLE_HIDE_MS);
				return () => popoutWindow.clearTimeout(timer);
			},
		});

		// Use the portal's document and timers, rather than the opener's window.
		// Leaving a control or moving focus out gives users a full idle interval.
		surface.addEventListener('pointermove', visibility.reveal);
		surface.addEventListener('pointerdown', visibility.reveal);
		controlsElement.addEventListener('pointerleave', visibility.reveal);
		controlsElement.addEventListener('focusin', visibility.reveal);
		controlsElement.addEventListener('focusout', visibility.reveal);
		popoutWindow.addEventListener('focus', visibility.reveal);
		// Native window events (moves while dragging the title bar, maximize and
		// restore) bypass the renderer's pointer events, so count them as activity.
		const unsubscribeWindowState = getDesktopBridge()?.subscribePopoutWindowState?.((state) => {
			if (state.windowName === windowName) visibility.reveal();
		});
		visibility.reveal();

		return () => {
			visibility.dispose();
			unsubscribeWindowState?.();
			surface.removeEventListener('pointermove', visibility.reveal);
			surface.removeEventListener('pointerdown', visibility.reveal);
			controlsElement.removeEventListener('pointerleave', visibility.reveal);
			controlsElement.removeEventListener('focusin', visibility.reveal);
			controlsElement.removeEventListener('focusout', visibility.reveal);
			popoutWindow.removeEventListener('focus', visibility.reveal);
		};
	}, [controlsElement, windowName]);

	return { visible, controlsRef: setControlsElement };
};

export { usePopoutControlsVisibility };
