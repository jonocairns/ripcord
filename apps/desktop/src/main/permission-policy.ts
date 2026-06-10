type TPermissionPolicyContext = {
	isTrustedRequester: boolean;
};

// Permissions the trusted renderer needs for its core features:
// - media: microphone/camera for voice.
// - display-capture: screen share (the source itself is gated by
//   setDisplayMediaRequestHandler).
// - fullscreen: expanding screen-share / external video tiles.
// - clipboard: copying invite links, 2FA backup codes, etc.
const TRUSTED_REQUESTER_PERMISSIONS: ReadonlySet<string> = new Set([
	'media',
	'display-capture',
	'fullscreen',
	'clipboard-read',
	'clipboard-sanitized-write',
	'pointerLock',
]);

// Permissions allowed regardless of the requesting origin. Embedded video
// players (e.g. YouTube iframes) legitimately request fullscreen, and it is a
// low-risk, user-gesture-gated capability.
const UNIVERSAL_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen']);

const isPermissionAllowed = (permission: string, context: TPermissionPolicyContext): boolean => {
	if (UNIVERSAL_PERMISSIONS.has(permission)) {
		return true;
	}

	if (context.isTrustedRequester && TRUSTED_REQUESTER_PERMISSIONS.has(permission)) {
		return true;
	}

	return false;
};

export type { TPermissionPolicyContext };
export { isPermissionAllowed };
