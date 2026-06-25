import { describe, expect, it } from 'bun:test';
import { VoiceConsumeAttemptTimeoutError, withConsumeAttemptTimeout } from '../hooks/consume-attempt-timeout';

describe('consume attempt timeout', () => {
	it('resolves when the operation finishes before the timeout', async () => {
		await expect(withConsumeAttemptTimeout(Promise.resolve('ok'), 10)).resolves.toBe('ok');
	});

	it('rejects when the operation does not finish before the timeout', async () => {
		const never = new Promise<string>(() => {});

		await expect(withConsumeAttemptTimeout(never, 1)).rejects.toBeInstanceOf(VoiceConsumeAttemptTimeoutError);
	});
});
