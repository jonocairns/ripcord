/// <reference types="vite/client" />
/// <reference types="zzfx" />
import type { TDesktopBridge } from './runtime/types';

// Extend the Window interface for global functions
declare global {
  interface Window {
    useToken: (token: string) => Promise<void>;
    printVoiceStats?: () => void;
    DEBUG?: boolean;
    sharkordDesktop?: TDesktopBridge;
  }

  const VITE_APP_VERSION: string;
}

export {};
