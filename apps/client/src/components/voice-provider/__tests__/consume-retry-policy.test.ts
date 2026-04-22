import { describe, expect, it } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import { CONSUME_RETRY_DELAYS_MS, getConsumeRetryDelayMs, shouldRetryConsume } from '../hooks/consume-retry-policy';

describe('consume retry policy', () => {
	it('retries audio consumer kinds', () => {
		expect(shouldRetryConsume(StreamKind.AUDIO)).toBe(true);
		expect(shouldRetryConsume(StreamKind.SCREEN_AUDIO)).toBe(true);
		expect(shouldRetryConsume(StreamKind.EXTERNAL_AUDIO)).toBe(true);
	});

	it('does not retry video consumer kinds', () => {
		expect(shouldRetryConsume(StreamKind.VIDEO)).toBe(false);
		expect(shouldRetryConsume(StreamKind.SCREEN)).toBe(false);
		expect(shouldRetryConsume(StreamKind.EXTERNAL_VIDEO)).toBe(false);
	});

	it('bounds audio retries to the configured delay list', () => {
		CONSUME_RETRY_DELAYS_MS.forEach((delayMs, index) => {
			expect(getConsumeRetryDelayMs(StreamKind.AUDIO, index)).toBe(delayMs);
		});

		expect(getConsumeRetryDelayMs(StreamKind.AUDIO, CONSUME_RETRY_DELAYS_MS.length)).toBeUndefined();
	});
});
