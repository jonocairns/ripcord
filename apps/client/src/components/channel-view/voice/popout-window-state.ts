import type { TDesktopBridge } from '@/runtime/types';

type TPopoutWindowStateBridge = Required<Pick<TDesktopBridge, 'getPopoutWindowState'>> &
	Pick<TDesktopBridge, 'subscribePopoutWindowState'>;

const watchPopoutWindowState = (
	bridge: TPopoutWindowStateBridge,
	windowName: string,
	onMaximizedChange: (isMaximized: boolean) => void,
) => {
	let disposed = false;
	let receivedEvent = false;
	const unsubscribe = bridge.subscribePopoutWindowState?.((state) => {
		if (disposed || state.windowName !== windowName) return;
		receivedEvent = true;
		onMaximizedChange(state.isMaximized);
	});

	void bridge.getPopoutWindowState(windowName).then(
		(state) => {
			// A delayed initial response must not overwrite a newer native event.
			if (!disposed && !receivedEvent) onMaximizedChange(state.isMaximized);
		},
		() => {
			// The window may close before its initial state is returned.
		},
	);

	return () => {
		disposed = true;
		unsubscribe?.();
	};
};

export { watchPopoutWindowState };
