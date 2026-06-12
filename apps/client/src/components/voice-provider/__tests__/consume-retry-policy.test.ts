import { describe, expect, it } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import {
	CONSUME_RETRY_DELAYS_MS,
	CONSUME_RETRY_MAX_ATTEMPTS,
	CONSUME_RETRY_TAIL_DELAY_MS,
	getConsumeRetryDelayMs,
	shouldRetryConsume,
} from '../hooks/consume-retry-policy';

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

	it('uses the fast delay list for the initial audio retries', () => {
		CONSUME_RETRY_DELAYS_MS.forEach((delayMs, index) => {
			expect(getConsumeRetryDelayMs(StreamKind.AUDIO, index)).toBe(delayMs);
		});
	});

	it('continues audio retries on the slow tail before giving up', () => {
		for (let index = CONSUME_RETRY_DELAYS_MS.length; index < CONSUME_RETRY_MAX_ATTEMPTS; index++) {
			expect(getConsumeRetryDelayMs(StreamKind.AUDIO, index)).toBe(CONSUME_RETRY_TAIL_DELAY_MS);
		}

		expect(getConsumeRetryDelayMs(StreamKind.AUDIO, CONSUME_RETRY_MAX_ATTEMPTS)).toBeUndefined();
	});
});
