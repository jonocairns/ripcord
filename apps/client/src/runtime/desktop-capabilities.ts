import type { TDesktopCapabilities, TDesktopCapabilityIssue, TDesktopPlatform, TSupportLevel } from './types';

type TLegacyDesktopCapabilities = Omit<TDesktopCapabilities, 'globalPushKeybinds' | 'issues' | 'notes'> & {
	globalPushKeybinds?: TSupportLevel;
	issues?: TDesktopCapabilityIssue[];
	notes?: string[];
};

const getDefaultGlobalPushKeybindSupport = (platform: TDesktopPlatform): TSupportLevel => {
	return platform === 'linux' ? 'best-effort' : 'supported';
};

const normalizeDesktopCapabilities = (capabilities: TLegacyDesktopCapabilities): TDesktopCapabilities => {
	return {
		...capabilities,
		globalPushKeybinds: capabilities.globalPushKeybinds ?? getDefaultGlobalPushKeybindSupport(capabilities.platform),
		issues: Array.isArray(capabilities.issues) ? capabilities.issues : [],
		notes: Array.isArray(capabilities.notes) ? capabilities.notes : [],
	};
};

export { normalizeDesktopCapabilities };
