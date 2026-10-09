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
	.ripcord-popout-controls {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 20;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 8px;
		max-width: calc(100% - 24px);
		opacity: 0;
		pointer-events: none;
		transition: opacity 140ms ease;
		-webkit-app-region: no-drag;
	}
	.ripcord-popout-controls[data-visible="true"],
	.ripcord-popout-controls:hover,
	.ripcord-popout-controls:focus-within {
		opacity: 1;
		pointer-events: auto;
	}
	.ripcord-popout-control-group {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.ripcord-popout-window-controls {
		border-left: 1px solid rgba(255, 255, 255, 0.4);
		padding-left: 12px;
	}
	.ripcord-popout-controls :focus-visible {
		outline: 2px solid white;
		outline-offset: 3px;
	}
	.ripcord-popout-drag-region {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 64px;
		z-index: 10;
		user-select: none;
		-webkit-app-region: drag;
	}
	@media (hover: none) {
		.ripcord-popout-controls {
			opacity: 1;
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
