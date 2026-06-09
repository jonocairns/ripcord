import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPermissionAllowed } from '../permission-policy';

void describe('isPermissionAllowed', () => {
	void it('allows core media permissions for a trusted requester', () => {
		for (const permission of [
			'media',
			'display-capture',
			'clipboard-read',
			'clipboard-sanitized-write',
			'pointerLock',
		]) {
			assert.equal(isPermissionAllowed(permission, { isTrustedRequester: true }), true, permission);
		}
	});

	void it('denies core media permissions for an untrusted requester', () => {
		for (const permission of [
			'media',
			'display-capture',
			'clipboard-read',
			'clipboard-sanitized-write',
			'pointerLock',
		]) {
			assert.equal(isPermissionAllowed(permission, { isTrustedRequester: false }), false, permission);
		}
	});

	void it('allows fullscreen regardless of requester (e.g. embedded video players)', () => {
		assert.equal(isPermissionAllowed('fullscreen', { isTrustedRequester: true }), true);
		assert.equal(isPermissionAllowed('fullscreen', { isTrustedRequester: false }), true);
	});

	void it('denies sensitive permissions even for a trusted requester', () => {
		for (const permission of [
			'geolocation',
			'notifications',
			'midi',
			'midiSysex',
			'hid',
			'serial',
			'usb',
			'bluetooth',
			'idle-detection',
			'openExternal',
			'unknown',
		]) {
			assert.equal(isPermissionAllowed(permission, { isTrustedRequester: true }), false, permission);
		}
	});
});
