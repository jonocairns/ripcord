import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type TPopoutWindowProps = {
	isOpen: boolean;
	windowName: string;
	title: string;
	onClose: () => void;
	children: React.ReactNode;
	onBlocked?: () => void;
	features?: string;
	targetWindow?: Window | null;
	preserveOnUnmount?: boolean;
};

const DEFAULT_WINDOW_FEATURES =
	'popup=yes,width=1280,height=720,resizable=yes,scrollbars=no,menubar=no,toolbar=no,location=no,status=no';

const ROOT_ID = 'sharkord-popout-root';

// Popouts have their own document, so application styles do not reach the
// portal. Keep overlay positioning and hover/focus behavior together here.
const POPOUT_STYLES = `
	.ripcord-popout-controls, .ripcord-popout-control-group {
		min-inline-size: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.ripcord-popout-titlebar {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		z-index: 20;
		display: flex;
		align-items: stretch;
		min-height: 32px;
		background: oklch(0.125 0.012 285);
		color: oklch(0.74 0.014 286);
		opacity: 0;
		pointer-events: none;
		transition: opacity 350ms ease-out;
		user-select: none;
	}
	.ripcord-popout-titlebar[data-visible="true"],
	.ripcord-popout-titlebar:hover,
	.ripcord-popout-titlebar:focus-within {
		opacity: 1;
		transition-duration: 120ms;
	}
	.ripcord-popout-titlebar[data-draggable="true"] {
		pointer-events: auto;
		-webkit-app-region: drag;
	}
	.ripcord-popout-title {
		flex: 1;
		min-width: 0;
		align-self: center;
		padding: 0 14px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		font-weight: 900;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.ripcord-popout-controls {
		display: flex;
		align-items: stretch;
		justify-content: flex-end;
		flex-wrap: wrap;
		max-width: 100%;
		margin-left: auto;
		pointer-events: none;
		-webkit-app-region: no-drag;
	}
	.ripcord-popout-titlebar[data-visible="true"] .ripcord-popout-controls,
	.ripcord-popout-controls:hover,
	.ripcord-popout-controls:focus-within {
		pointer-events: auto;
	}
	.ripcord-popout-control-group {
		display: flex;
		align-items: stretch;
	}
	.ripcord-popout-window-controls {
		border-left: 1px solid rgba(255, 255, 255, 0.08);
	}
	.ripcord-popout-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		width: 46px;
		min-height: 32px;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 12px;
		cursor: default;
		transition: background-color 140ms ease-in-out, color 140ms ease-in-out;
	}
	.ripcord-popout-button:hover {
		background: oklch(0.97 0.005 286 / 0.07);
		color: oklch(0.97 0.005 286);
	}
	.ripcord-popout-button:active {
		background: oklch(0.97 0.005 286 / 0.12);
	}
	.ripcord-popout-close-button:hover {
		background: oklch(0.704 0.191 22.216);
		color: #ffffff;
	}
	.ripcord-popout-text-button {
		width: auto;
		padding: 0 12px;
	}
	.ripcord-popout-small-button {
		width: 28px;
		min-height: 24px;
	}
	.ripcord-popout-volume-panel {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px 0 6px;
	}
	.ripcord-popout-volume-panel input {
		width: 88px;
		cursor: pointer;
	}
	.ripcord-popout-volume-panel span {
		width: 32px;
		text-align: right;
		font-size: 11px;
	}
	.ripcord-popout-controls :focus-visible {
		outline: 2px solid white;
		outline-offset: -2px;
	}
	@media (hover: none) {
		.ripcord-popout-titlebar {
			opacity: 1;
		}
		.ripcord-popout-controls {
			pointer-events: auto;
		}
	}
`;

const syncPopoutIcons = (targetWindow: Window) => {
	const sourceIcons = Array.from(
		window.document.querySelectorAll<HTMLLinkElement>("link[rel~='icon'], link[rel='apple-touch-icon']"),
	);

	if (sourceIcons.length === 0) {
		return;
	}

	const popoutHead = targetWindow.document.head;
	const existingIcons = popoutHead.querySelectorAll("link[rel~='icon'], link[rel='apple-touch-icon']");

	existingIcons.forEach((icon) => {
		icon.remove();
	});

	sourceIcons.forEach((sourceIcon) => {
		const clonedIcon = targetWindow.document.createElement('link');

		if (sourceIcon.rel) {
			clonedIcon.rel = sourceIcon.rel;
		}

		if (sourceIcon.type) {
			clonedIcon.type = sourceIcon.type;
		}

		const sizes = sourceIcon.getAttribute('sizes');
		if (sizes) {
			clonedIcon.setAttribute('sizes', sizes);
		}

		clonedIcon.href = sourceIcon.href;
		popoutHead.appendChild(clonedIcon);
	});
};

const setupPopoutDocument = (targetWindow: Window, title: string): HTMLElement => {
	const popoutDocument = targetWindow.document;
	popoutDocument.title = title;
	syncPopoutIcons(targetWindow);

	let root = popoutDocument.getElementById(ROOT_ID);

	if (!root) {
		popoutDocument.body.style.margin = '0';
		popoutDocument.body.style.background = '#000000';
		popoutDocument.body.style.color = '#ffffff';
		popoutDocument.body.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif';
		popoutDocument.body.style.overflow = 'hidden';

		root = popoutDocument.createElement('div');
		root.id = ROOT_ID;
		root.style.height = '100vh';
		root.style.width = '100vw';
		const style = popoutDocument.createElement('style');
		style.textContent = POPOUT_STYLES;
		popoutDocument.head.appendChild(style);

		popoutDocument.body.appendChild(root);
	}

	return root;
};

const PopoutWindow = memo(
	({
		isOpen,
		windowName,
		title,
		onClose,
		children,
		onBlocked,
		features = DEFAULT_WINDOW_FEATURES,
		targetWindow,
		preserveOnUnmount = false,
	}: TPopoutWindowProps) => {
		const popoutWindowRef = useRef<Window | null>(null);
		const [container, setContainer] = useState<HTMLElement | null>(null);

		useEffect(() => {
			if (!isOpen) {
				return;
			}

			let activeWindow = targetWindow && !targetWindow.closed ? targetWindow : popoutWindowRef.current;

			if (!activeWindow || activeWindow.closed) {
				activeWindow = window.open('', windowName, features);

				if (!activeWindow) {
					onBlocked?.();
					onClose();
					return;
				}
			}

			popoutWindowRef.current = activeWindow;

			const root = setupPopoutDocument(activeWindow, title);
			setContainer(root);
			activeWindow.focus();

			const handleUnload = () => {
				setContainer(null);
				popoutWindowRef.current = null;
				onClose();
			};

			activeWindow.addEventListener('beforeunload', handleUnload);
			activeWindow.addEventListener('unload', handleUnload);

			return () => {
				activeWindow?.removeEventListener('beforeunload', handleUnload);
				activeWindow?.removeEventListener('unload', handleUnload);
			};
		}, [features, isOpen, onBlocked, onClose, targetWindow, title, windowName]);

		useEffect(() => {
			if (!isOpen && popoutWindowRef.current && !popoutWindowRef.current.closed && !preserveOnUnmount) {
				popoutWindowRef.current.close();
			}

			if (!isOpen && !preserveOnUnmount) {
				popoutWindowRef.current = null;
				setContainer(null);
			}
		}, [isOpen, preserveOnUnmount]);

		useEffect(() => {
			if (popoutWindowRef.current && !popoutWindowRef.current.closed) {
				popoutWindowRef.current.document.title = title;
			}
		}, [title]);

		useEffect(() => {
			return () => {
				if (!preserveOnUnmount && popoutWindowRef.current && !popoutWindowRef.current.closed) {
					popoutWindowRef.current.close();
					popoutWindowRef.current = null;
				}
			};
		}, [preserveOnUnmount]);

		if (!isOpen || !container) {
			return null;
		}

		return createPortal(children, container);
	},
);

PopoutWindow.displayName = 'PopoutWindow';

export { DEFAULT_WINDOW_FEATURES, PopoutWindow };
