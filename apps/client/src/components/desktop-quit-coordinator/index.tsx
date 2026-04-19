import { memo, useEffect } from 'react';
import { flushVoiceForDesktopQuit } from '@/features/server/voice/actions';
import { getDesktopBridge } from '@/runtime/desktop-bridge';

const DesktopQuitCoordinator = memo(() => {
	useEffect(() => {
		const desktopBridge = getDesktopBridge();

		if (!desktopBridge) {
			return;
		}

		let flushPromise: Promise<void> | undefined;

		return desktopBridge.subscribeBeforeQuit(() => {
			if (!flushPromise) {
				flushPromise = flushVoiceForDesktopQuit()
					.then(() => undefined)
					.finally(() => {
						flushPromise = undefined;
					});
			}

			return flushPromise;
		});
	}, []);

	return null;
});

export { DesktopQuitCoordinator };
