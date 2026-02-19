import type { TDesktopBridge } from './types';

const getDesktopBridge = (): TDesktopBridge | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.sharkordDesktop;
};

const isDesktopRuntime = () => {
  return !!getDesktopBridge();
};

export { getDesktopBridge, isDesktopRuntime };
