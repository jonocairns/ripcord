type TPopoutWindowAction = 'minimize' | 'toggle-maximize';

type TPopoutWindowState = {
	windowName: string;
	isMaximized: boolean;
};

type TMediaPopoutWindow = {
	isDestroyed: () => boolean;
	isMaximized: () => boolean;
	minimize: () => void;
	maximize: () => void;
	unmaximize: () => void;
};

const isMediaPopoutWindowName = (windowName: string): boolean => {
	return ['screen-share-', 'external-stream-'].some(
		(prefix) => windowName.startsWith(prefix) && windowName.length > prefix.length,
	);
};

const resolvePopoutWindow = (
	windows: ReadonlyMap<string, TMediaPopoutWindow>,
	windowName: string,
): TMediaPopoutWindow => {
	const popoutWindow = windows.get(windowName);
	if (!popoutWindow || popoutWindow.isDestroyed()) {
		throw new Error('Pop-out window is no longer available');
	}
	return popoutWindow;
};

const getPopoutWindowState = (
	windows: ReadonlyMap<string, TMediaPopoutWindow>,
	windowName: string,
): TPopoutWindowState => {
	return { windowName, isMaximized: resolvePopoutWindow(windows, windowName).isMaximized() };
};

const controlPopoutWindow = (
	windows: ReadonlyMap<string, TMediaPopoutWindow>,
	windowName: string,
	action: TPopoutWindowAction,
): void => {
	const popoutWindow = resolvePopoutWindow(windows, windowName);

	if (action === 'minimize') {
		popoutWindow.minimize();
	} else if (popoutWindow.isMaximized()) {
		popoutWindow.unmaximize();
	} else {
		popoutWindow.maximize();
	}
};

export type { TMediaPopoutWindow, TPopoutWindowAction, TPopoutWindowState };
export { controlPopoutWindow, getPopoutWindowState, isMediaPopoutWindowName };
