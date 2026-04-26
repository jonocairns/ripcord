import { Copy, Minus, Square, X } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import type { TDesktopWindowControlsState } from '@/runtime/types';

const DesktopTitlebar = memo(() => {
	const desktopBridge = getDesktopBridge();
	const [windowState, setWindowState] = useState<TDesktopWindowControlsState>();

	useEffect(() => {
		if (!desktopBridge?.getWindowControlsState) {
			return;
		}

		let cancelled = false;

		void desktopBridge
			.getWindowControlsState()
			.then((state) => {
				if (!cancelled) {
					setWindowState(state);
				}
			})
			.catch(() => undefined);

		const unsubscribe = desktopBridge.subscribeWindowControlsState?.((state) => {
			setWindowState(state);
		});

		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [desktopBridge]);

	const handleMinimize = useCallback(() => {
		void desktopBridge?.minimizeWindow?.();
	}, [desktopBridge]);

	const handleToggleMaximize = useCallback(() => {
		const togglePromise = desktopBridge?.toggleMaximizeWindow?.();
		if (!togglePromise) {
			return;
		}

		void togglePromise.then((state) => {
			setWindowState(state);
		});
	}, [desktopBridge]);

	const handleClose = useCallback(() => {
		void desktopBridge?.closeWindow?.();
	}, [desktopBridge]);

	if (!desktopBridge || !windowState?.usesCustomTitlebar) {
		return null;
	}

	return (
		<div className="desktop-titlebar">
			<div className="desktop-titlebar__drag" onDoubleClick={handleToggleMaximize}>
				<span className="desktop-titlebar__title">Ripcord</span>
			</div>

			<div className="desktop-titlebar__actions">
				<button
					type="button"
					className="desktop-titlebar__button"
					aria-label="Minimize window"
					onClick={handleMinimize}
				>
					<Minus className="h-3.5 w-3.5" strokeWidth={1.8} />
				</button>
				<button
					type="button"
					className="desktop-titlebar__button"
					aria-label={windowState.isMaximized ? 'Restore window' : 'Maximize window'}
					onClick={handleToggleMaximize}
				>
					{windowState.isMaximized ? (
						<Copy className="h-3.5 w-3.5" strokeWidth={1.8} />
					) : (
						<Square className="h-3.5 w-3.5" strokeWidth={1.8} />
					)}
				</button>
				<button
					type="button"
					className="desktop-titlebar__button"
					data-close="true"
					aria-label="Close window"
					onClick={handleClose}
				>
					<X className="h-3.5 w-3.5" strokeWidth={1.8} />
				</button>
			</div>
		</div>
	);
});

export { DesktopTitlebar };
