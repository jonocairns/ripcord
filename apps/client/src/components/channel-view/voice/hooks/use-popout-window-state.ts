import { useEffect, useState } from 'react';
import { getDesktopBridge } from '@/runtime/desktop-bridge';

const usePopoutWindowState = (windowName: string) => {
	const desktopBridge = getDesktopBridge();
	const [isMaximized, setIsMaximized] = useState(false);

	useEffect(() => {
		if (!desktopBridge?.getPopoutWindowState) return;
		let cancelled = false;
		let receivedEvent = false;
		const unsubscribe = desktopBridge.subscribePopoutWindowState?.((state) => {
			if (state.windowName !== windowName) return;
			receivedEvent = true;
			setIsMaximized(state.isMaximized);
		});

		void desktopBridge.getPopoutWindowState(windowName).then(
			(state) => {
				// A delayed initial response must not overwrite a newer native event.
				if (!cancelled && !receivedEvent) setIsMaximized(state.isMaximized);
			},
			() => {
				// The window may close before its initial state is returned.
			},
		);

		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [desktopBridge, windowName]);

	return isMaximized;
};

export { usePopoutWindowState };
