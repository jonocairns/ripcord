import { ArrowDownLeft, Copy, Maximize2, Minimize2, Minus, Square, X } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { toast } from 'sonner';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { usePopoutControlsVisibility } from './hooks/use-popout-controls-visibility';
import { usePopoutWindowState } from './hooks/use-popout-window-state';
import { POPOUT_BUTTON_STYLE } from './popout-control-styles';

type TPopoutWindowControlsProps = {
	windowName: string;
	title: string;
	isFullscreen: boolean;
	onToggleFullscreen: () => void;
	onClose: () => void;
	children?: ReactNode;
};

const PopoutWindowControls = memo(
	({ windowName, title, isFullscreen, onToggleFullscreen, onClose, children }: TPopoutWindowControlsProps) => {
		// The portal runs in the opener. Route native controls through its trusted
		// bridge with the popout name, so they never act on the main window.
		const desktopBridge = getDesktopBridge();
		const controlPopoutWindow = desktopBridge?.controlPopoutWindow;
		const isMaximized = usePopoutWindowState(windowName);
		const { visible, controlsRef } = usePopoutControlsVisibility();
		const handleWindowAction = (action: 'minimize' | 'toggle-maximize') => {
			void controlPopoutWindow?.(windowName, action).catch(() => {
				toast.error('Could not update the pop-out window.');
			});
		};

		return (
			// Frameless Electron popouts use this bar as their title bar. It stays
			// draggable while faded out, so users can always move the window.
			<div
				className="ripcord-popout-titlebar"
				data-visible={visible}
				data-draggable={Boolean(controlPopoutWindow) && !isFullscreen}
			>
				{controlPopoutWindow && <span className="ripcord-popout-title">{title}</span>}
				<fieldset ref={controlsRef} className="ripcord-popout-controls" aria-label="Pop-out controls">
					<fieldset className="ripcord-popout-control-group" aria-label="Playback controls">
						{children}
						<button
							type="button"
							onClick={onToggleFullscreen}
							title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
							aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
							style={POPOUT_BUTTON_STYLE}
						>
							{isFullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
						</button>
						{!desktopBridge && (
							<button
								type="button"
								onClick={onClose}
								title="Return to app"
								aria-label="Return to app"
								style={POPOUT_BUTTON_STYLE}
							>
								<ArrowDownLeft size={20} />
							</button>
						)}
					</fieldset>
					{desktopBridge && (
						<fieldset
							className="ripcord-popout-control-group ripcord-popout-window-controls"
							aria-label="Window controls"
						>
							{controlPopoutWindow && !isFullscreen && (
								<>
									<button
										type="button"
										onClick={() => handleWindowAction('minimize')}
										title="Minimize window"
										aria-label="Minimize window"
										style={POPOUT_BUTTON_STYLE}
									>
										<Minus size={20} />
									</button>
									<button
										type="button"
										onClick={() => handleWindowAction('toggle-maximize')}
										title={isMaximized ? 'Restore window' : 'Maximize window'}
										aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
										style={POPOUT_BUTTON_STYLE}
									>
										{isMaximized ? <Copy size={18} /> : <Square size={18} />}
									</button>
								</>
							)}
							<button
								type="button"
								onClick={onClose}
								title="Close pop-out"
								aria-label="Close pop-out"
								style={POPOUT_BUTTON_STYLE}
							>
								<X size={20} />
							</button>
						</fieldset>
					)}
				</fieldset>
			</div>
		);
	},
);

PopoutWindowControls.displayName = 'PopoutWindowControls';

export { PopoutWindowControls };
