import { ArrowDownLeft, Maximize2, Minimize2, Minus, Square, X } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { toast } from 'sonner';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { usePopoutControlsVisibility } from './hooks/use-popout-controls-visibility';
import { usePopoutWindowState } from './hooks/use-popout-window-state';

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
		const { visible, controlsRef } = usePopoutControlsVisibility(windowName);
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
							className="ripcord-popout-button"
						>
							{isFullscreen ? <Minimize2 size={14} strokeWidth={1.5} /> : <Maximize2 size={14} strokeWidth={1.5} />}
						</button>
						{!desktopBridge && (
							<button
								type="button"
								onClick={onClose}
								title="Return to app"
								aria-label="Return to app"
								className="ripcord-popout-button"
							>
								<ArrowDownLeft size={14} strokeWidth={1.5} />
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
										className="ripcord-popout-button"
									>
										<Minus size={14} strokeWidth={1.2} />
									</button>
									<button
										type="button"
										onClick={() => handleWindowAction('toggle-maximize')}
										title={isMaximized ? 'Restore window' : 'Maximize window'}
										aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
										className="ripcord-popout-button"
									>
										{isMaximized ? (
											<svg
												viewBox="0 0 12 12"
												width={12}
												height={12}
												fill="none"
												stroke="currentColor"
												strokeWidth="1.2"
												aria-hidden="true"
											>
												<rect x="4" y="1" width="7" height="7" />
												<rect x="1" y="4" width="7" height="7" />
											</svg>
										) : (
											<Square size={12} strokeWidth={1.2} />
										)}
									</button>
								</>
							)}
							<button
								type="button"
								onClick={onClose}
								title="Close pop-out"
								aria-label="Close pop-out"
								className="ripcord-popout-button ripcord-popout-close-button"
							>
								<X size={16} strokeWidth={1.5} />
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
