import type { TGenericObject } from '@sharkord/shared';
import type { ServerScreen } from '@/components/server-screens/screens';
import { getInitialServerScreenState, useServerScreensStore } from './slice';

export const openServerScreen = (serverScreen: ServerScreen, props?: TGenericObject) => {
	useServerScreensStore.setState({
		openServerScreen: serverScreen,
		props: props || {},
		isOpen: true,
	});
};

export const closeServerScreens = () => {
	useServerScreensStore.setState(getInitialServerScreenState());
};

export const resetServerScreens = () => {
	useServerScreensStore.setState(getInitialServerScreenState());
};
