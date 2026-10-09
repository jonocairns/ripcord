import { useEffect, useState } from 'react';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { watchPopoutWindowState } from '../popout-window-state';

const usePopoutWindowState = (windowName: string) => {
	const desktopBridge = getDesktopBridge();
	const [isMaximized, setIsMaximized] = useState(false);

	useEffect(() => {
		const getPopoutWindowState = desktopBridge?.getPopoutWindowState;
		if (!getPopoutWindowState) return;
		return watchPopoutWindowState(
			{ getPopoutWindowState, subscribePopoutWindowState: desktopBridge.subscribePopoutWindowState },
			windowName,
			setIsMaximized,
		);
	}, [desktopBridge, windowName]);

	return isMaximized;
};

export { usePopoutWindowState };
