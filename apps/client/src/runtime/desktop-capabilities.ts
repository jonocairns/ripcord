import type { TDesktopCapabilities, TDesktopPlatform, TSupportLevel } from './types';

const getDefaultGlobalPushKeybindSupport = (platform: TDesktopPlatform): TSupportLevel => {
	return platform === 'linux' ? 'best-effort' : 'supported';
};

const normalizeDesktopCapabilities = (capabilities: TDesktopCapabilities): TDesktopCapabilities => {
	return {
		...capabilities,
		globalPushKeybinds: capabilities.globalPushKeybinds ?? getDefaultGlobalPushKeybindSupport(capabilities.platform),
		issues: Array.isArray(capabilities.issues) ? capabilities.issues : [],
		notes: Array.isArray(capabilities.notes) ? capabilities.notes : [],
	};
};

export { normalizeDesktopCapabilities };
