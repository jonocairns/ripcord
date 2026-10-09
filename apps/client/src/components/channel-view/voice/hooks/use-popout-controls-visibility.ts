import { useEffect, useState } from 'react';
import { createPopoutControlsVisibility } from '../popout-controls-visibility';

const IDLE_HIDE_MS = 2500;

const usePopoutControlsVisibility = () => {
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
		visibility.reveal();

		return () => {
			visibility.dispose();
			surface.removeEventListener('pointermove', visibility.reveal);
			surface.removeEventListener('pointerdown', visibility.reveal);
			controlsElement.removeEventListener('pointerleave', visibility.reveal);
			controlsElement.removeEventListener('focusin', visibility.reveal);
			controlsElement.removeEventListener('focusout', visibility.reveal);
			popoutWindow.removeEventListener('focus', visibility.reveal);
		};
	}, [controlsElement]);

	return { visible, controlsRef: setControlsElement };
};

export { usePopoutControlsVisibility };
