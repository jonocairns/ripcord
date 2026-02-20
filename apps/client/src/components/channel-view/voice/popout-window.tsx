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
};

const DEFAULT_WINDOW_FEATURES =
  'popup=yes,width=1280,height=720,resizable=yes,scrollbars=no,menubar=no,toolbar=no,location=no,status=no';

const ROOT_ID = 'sharkord-popout-root';

const syncPopoutIcons = (targetWindow: Window) => {
  const sourceIcons = Array.from(
    window.document.querySelectorAll<HTMLLinkElement>(
      "link[rel~='icon'], link[rel='apple-touch-icon']"
    )
  );

  if (sourceIcons.length === 0) {
    return;
  }

  const popoutHead = targetWindow.document.head;
  const existingIcons = popoutHead.querySelectorAll(
    "link[rel~='icon'], link[rel='apple-touch-icon']"
  );

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

const setupPopoutDocument = (
  targetWindow: Window,
  title: string
): HTMLDivElement => {
  const popoutDocument = targetWindow.document;
  popoutDocument.title = title;
  syncPopoutIcons(targetWindow);

  let root = popoutDocument.getElementById(ROOT_ID) as HTMLDivElement | null;

  if (!root) {
    popoutDocument.body.style.margin = '0';
    popoutDocument.body.style.background = '#000000';
    popoutDocument.body.style.color = '#ffffff';
    popoutDocument.body.style.fontFamily =
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif';
    popoutDocument.body.style.overflow = 'hidden';

    root = popoutDocument.createElement('div');
    root.id = ROOT_ID;
    root.style.height = '100vh';
    root.style.width = '100vw';

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
    features = DEFAULT_WINDOW_FEATURES
  }: TPopoutWindowProps) => {
    const popoutWindowRef = useRef<Window | null>(null);
    const [container, setContainer] = useState<HTMLDivElement | null>(null);

    useEffect(() => {
      if (!isOpen) {
        return;
      }

      let targetWindow = popoutWindowRef.current;

      if (!targetWindow || targetWindow.closed) {
        targetWindow = window.open('', windowName, features);

        if (!targetWindow) {
          onBlocked?.();
          onClose();
          return;
        }

        popoutWindowRef.current = targetWindow;
      }

      const root = setupPopoutDocument(targetWindow, title);
      setContainer(root);
      targetWindow.focus();

      const handleUnload = () => {
        setContainer(null);
        popoutWindowRef.current = null;
        onClose();
      };

      targetWindow.addEventListener('beforeunload', handleUnload);
      targetWindow.addEventListener('unload', handleUnload);

      return () => {
        targetWindow?.removeEventListener('beforeunload', handleUnload);
        targetWindow?.removeEventListener('unload', handleUnload);
      };
    }, [features, isOpen, onBlocked, onClose, title, windowName]);

    useEffect(() => {
      if (!isOpen && popoutWindowRef.current && !popoutWindowRef.current.closed) {
        popoutWindowRef.current.close();
      }

      if (!isOpen) {
        popoutWindowRef.current = null;
        setContainer(null);
      }
    }, [isOpen]);

    useEffect(() => {
      if (popoutWindowRef.current && !popoutWindowRef.current.closed) {
        popoutWindowRef.current.document.title = title;
      }
    }, [title]);

    useEffect(() => {
      return () => {
        if (popoutWindowRef.current && !popoutWindowRef.current.closed) {
          popoutWindowRef.current.close();
        }
      };
    }, []);

    if (!isOpen || !container) {
      return null;
    }

    return createPortal(children, container);
  }
);

PopoutWindow.displayName = 'PopoutWindow';

export { PopoutWindow };
