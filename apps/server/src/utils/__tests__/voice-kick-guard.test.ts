import { afterEach, describe, expect, test } from 'bun:test';
import {
	blockVoiceRestoreAfterKick,
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

	test('falls back to the access token for clients without an instance id', () => {
		expect(blockVoiceRestoreAfterKick(1, { token: 'token-a' })).toBe(true);
		expect(isVoiceRestoreBlockedAfterKick(1, { token: 'token-a' })).toBe(true);
		expect(isVoiceRestoreBlockedAfterKick(1, { token: 'token-b' })).toBe(false);
	});

	test('expires stale guards', async () => {
		blockVoiceRestoreAfterKick(1, { clientInstanceId: 'client-a' }, 1);
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(isVoiceRestoreBlockedAfterKick(1, { clientInstanceId: 'client-a' })).toBe(false);
	});
});
