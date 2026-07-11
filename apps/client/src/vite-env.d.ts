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
		webkitAudioContext?: typeof AudioContext;
	}

	const VITE_APP_VERSION: string;

	interface ImportMetaEnv {
		// Opt-in flag for Stage 1 native app-audio RTP ingest (default off).
		readonly VITE_VOICE_NATIVE_APP_AUDIO?: string;
	}
}
