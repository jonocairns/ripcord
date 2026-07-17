import { afterEach, describe, expect, test } from 'bun:test';
import {
	blockVoiceRestoreAfterKick,
	clearVoiceRestoreBlockAfterKick,
	getVoiceKickGuardIdentity,
	isVoiceRestoreBlockedAfterKick,
	resetVoiceKickGuardsForTests,
} from '../voice-kick-guard';

afterEach(() => {
	resetVoiceKickGuardsForTests();
});

describe('voice kick restore guard', () => {
	test('blocks only the kicked client instance', () => {
		expect(blockVoiceRestoreAfterKick(1, { clientInstanceId: 'client-a' })).toBe(true);
		expect(isVoiceRestoreBlockedAfterKick(1, { clientInstanceId: 'client-a' })).toBe(true);
		expect(isVoiceRestoreBlockedAfterKick(1, { clientInstanceId: 'client-b' })).toBe(false);
		expect(isVoiceRestoreBlockedAfterKick(2, { clientInstanceId: 'client-a' })).toBe(false);
	});

	test('reads the guard identity from a tracked connection', () => {
		expect(getVoiceKickGuardIdentity({ clientInstanceId: 'client-a', token: 'token-a' })).toEqual({
			clientInstanceId: 'client-a',
			token: 'token-a',
		});
		expect(getVoiceKickGuardIdentity({ clientInstanceId: '', token: '' })).toEqual({
			clientInstanceId: undefined,
			token: undefined,
		});
	});

	test('falls back to the access token for clients without an instance id', () => {
		expect(blockVoiceRestoreAfterKick(1, { token: 'token-a' })).toBe(true);
		expect(isVoiceRestoreBlockedAfterKick(1, { token: 'token-a' })).toBe(true);
		expect(isVoiceRestoreBlockedAfterKick(1, { token: 'token-b' })).toBe(false);
	});

	test('clears the guard after an explicit join', () => {
		blockVoiceRestoreAfterKick(1, { clientInstanceId: 'client-a' });

		expect(clearVoiceRestoreBlockAfterKick(1, { clientInstanceId: 'client-a' })).toBe(true);
		expect(isVoiceRestoreBlockedAfterKick(1, { clientInstanceId: 'client-a' })).toBe(false);
	});

	test('does not block clients without an identity', () => {
		expect(blockVoiceRestoreAfterKick(1, {})).toBe(false);
		expect(isVoiceRestoreBlockedAfterKick(1, {})).toBe(false);
	});

	test('expires stale guards', async () => {
		blockVoiceRestoreAfterKick(1, { clientInstanceId: 'client-a' }, 1);
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(isVoiceRestoreBlockedAfterKick(1, { clientInstanceId: 'client-a' })).toBe(false);
	});
});
