import { Copy, Minus, Square, X } from 'lucide-react';
import { type ComponentProps, memo, useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

import { getDesktopBridge } from '@/runtime/desktop-bridge';
import type { TDesktopWindowControlsState } from '@/runtime/types';

const TitlebarButton = ({ className, ...props }: ComponentProps<'button'>) => (
	<button
		type="button"
		className={cn(
			'inline-flex h-8 w-[2.875rem] cursor-default items-center justify-center border-0 bg-transparent text-[rgb(114,118,125)] transition-[background-color,color] duration-[140ms] ease-in-out [-webkit-app-region:no-drag] hover:bg-white/[0.07] hover:text-[rgb(220,222,225)] active:bg-white/[0.12]',
			className,
		)}
		{...props}
	/>
);

const DesktopTitlebar = memo(() => {
	const desktopBridge = getDesktopBridge();
	const [windowState, setWindowState] = useState<TDesktopWindowControlsState>();

	useEffect(() => {
		if (!desktopBridge?.getWindowControlsState) {
			return;
		}

		let cancelled = false;

		const fetchState = async () => {
			const state = await desktopBridge?.getWindowControlsState?.();
			if (!cancelled && state) {
				setWindowState(state);
			}
		};

		void fetchState();

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

	const handleToggleMaximize = useCallback(async () => {
		const state = await desktopBridge?.toggleMaximizeWindow?.();
		if (state) {
			setWindowState(state);
		}
	}, [desktopBridge]);

	const handleClose = useCallback(() => {
		void desktopBridge?.closeWindow?.();
	}, [desktopBridge]);

	if (!desktopBridge || !windowState?.usesCustomTitlebar) {
		return null;
	}

	return (
		<div className="flex h-8 shrink-0 select-none items-stretch justify-between bg-[rgb(32,34,37)] text-slate-100">
			<div
				className="flex min-w-0 flex-1 items-center gap-2.5 px-3.5 [-webkit-app-region:drag]"
				onDoubleClick={handleToggleMaximize}
			>
				<span className="min-w-0 truncate text-[0.6875rem] font-black uppercase tracking-[0.06em] text-[rgb(114,118,125)]">
					Ripcord
				</span>
			</div>

			<div className="flex items-stretch [-webkit-app-region:no-drag]">
				<TitlebarButton aria-label="Minimize window" onClick={handleMinimize}>
					<Minus className="h-3.5 w-3.5" strokeWidth={1.2} />
				</TitlebarButton>
				<TitlebarButton
					aria-label={windowState.isMaximized ? 'Restore window' : 'Maximize window'}
					onClick={handleToggleMaximize}
				>
					{windowState.isMaximized ? (
						<Copy className="h-3 w-3" strokeWidth={1.2} />
					) : (
						<Square className="h-3 w-3" strokeWidth={1.2} />
					)}
				</TitlebarButton>
				<TitlebarButton
					className="hover:bg-[rgb(237,66,69)] hover:text-white"
					aria-label="Close window"
					onClick={handleClose}
				>
					<X className="h-4 w-4" strokeWidth={1.5} />
				</TitlebarButton>
			</div>
		</div>
	);
});

export { DesktopTitlebar };
