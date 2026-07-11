import { describe, expect, test } from 'bun:test';
import {
	claimVoiceSessionExecution,
	createVoiceSessionExecutionOwnership,
	invalidateVoiceSessionExecution,
} from '../hooks/session-execution-ownership';

describe('voice session execution ownership', () => {
	test('only the latest claimed execution remains current', () => {
		const ownership = createVoiceSessionExecutionOwnership();
		const first = claimVoiceSessionExecution(ownership);
		const second = claimVoiceSessionExecution(ownership);

		expect(first()).toBe(false);
		expect(second()).toBe(true);
	});

	test('cleanup invalidates the active execution', () => {
		const ownership = createVoiceSessionExecutionOwnership();
		const active = claimVoiceSessionExecution(ownership);

		invalidateVoiceSessionExecution(ownership);

		expect(active()).toBe(false);
	});
});
