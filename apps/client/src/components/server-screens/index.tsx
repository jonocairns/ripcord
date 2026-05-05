import { createElement, type JSX, memo, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModViewOpen } from '@/features/app/hooks';
import { closeServerScreens } from '@/features/server-screens/actions';
import { useServerScreenInfo } from '@/features/server-screens/hooks';
import { CategorySettings } from './category-settings';
import { ChannelSettings } from './channel-settings';
import { ServerScreen } from './screens';
import { ServerSettings } from './server-settings';
import { UserSettings } from './user-settings';

const ScreensMap = {
	[ServerScreen.SERVER_SETTINGS]: ServerSettings,
	[ServerScreen.CHANNEL_SETTINGS]: ChannelSettings,
	[ServerScreen.USER_SETTINGS]: UserSettings,
	[ServerScreen.CATEGORY_SETTINGS]: CategorySettings,
};

type TComponentWrapperProps = {
	children: React.ReactNode;
};

const ComponentWrapper = ({ children }: TComponentWrapperProps) => {
	const { isOpen } = useModViewOpen();

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			// when mod view is open, do not close server screens
			if (isOpen) return;

			if (e.key === 'Escape') {
				closeServerScreens();
			}
		},
		[isOpen],
	);

	useEffect(() => {
		document.addEventListener('keydown', handleKeyDown);

		return () => {
			document.removeEventListener('keydown', handleKeyDown);
		};
	}, [handleKeyDown]);

	return children;
};

const ServerScreensProvider = memo(() => {
	const { isOpen, props, openServerScreen } = useServerScreenInfo();
	const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

	useEffect(() => {
		setPortalRoot(document.getElementById('portal'));
	}, []);

	let component: JSX.Element | null = null;

	if (openServerScreen && ScreensMap[openServerScreen]) {
		const baseProps = {
			...props,
			isOpen,
			close: closeServerScreens,
		};

		// @ts-expect-error - é lidar irmoum
		component = createElement(ScreensMap[openServerScreen], baseProps);
	}

	const realIsOpen = isOpen && !!component;

	useLayoutEffect(() => {
		if (!portalRoot) return;
		portalRoot.style.display = realIsOpen ? 'block' : 'none';
	}, [portalRoot, realIsOpen]);

	if (!realIsOpen || !portalRoot) return null;

	return createPortal(<ComponentWrapper>{component}</ComponentWrapper>, portalRoot);
});

export { ServerScreensProvider };
