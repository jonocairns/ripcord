import { describe, expect, it } from 'bun:test';
import { DisconnectCode } from '@sharkord/shared';
import { isReconnectPausedDisconnectCode, shouldRestoreVoiceAfterDisconnect } from '../disconnect-utils';

describe('shouldRestoreVoiceAfterDisconnect', () => {
	it('keeps the previous voice channel for unexpected transport closes', () => {
		expect(shouldRestoreVoiceAfterDisconnect(DisconnectCode.UNEXPECTED)).toBe(true);
		expect(shouldRestoreVoiceAfterDisconnect(1000)).toBe(true);
	});

	it('does not keep the previous voice channel for forced removals', () => {
		expect(shouldRestoreVoiceAfterDisconnect(DisconnectCode.KICKED)).toBe(false);
		expect(shouldRestoreVoiceAfterDisconnect(DisconnectCode.BANNED)).toBe(false);
	});
});

describe('isReconnectPausedDisconnectCode', () => {
	it('pauses reconnect for client errors and moderation disconnects', () => {
		expect(isReconnectPausedDisconnectCode(400)).toBe(true);
		expect(isReconnectPausedDisconnectCode(DisconnectCode.KICKED)).toBe(true);
		expect(isReconnectPausedDisconnectCode(DisconnectCode.BANNED)).toBe(true);
	});

	it('allows reconnect for server shutdowns and generic transport drops', () => {
		expect(isReconnectPausedDisconnectCode(DisconnectCode.SERVER_SHUTDOWN)).toBe(false);
		expect(isReconnectPausedDisconnectCode(DisconnectCode.UNEXPECTED)).toBe(false);
	});
});
