import { StreamKind } from '@sharkord/shared';

const CONSUME_RETRY_DELAYS_MS: readonly number[] = [500, 1_500, 3_000];

const shouldRetryConsume = (kind: StreamKind) => {
	return kind === StreamKind.AUDIO || kind === StreamKind.SCREEN_AUDIO || kind === StreamKind.EXTERNAL_AUDIO;
};

const getConsumeRetryDelayMs = (kind: StreamKind, failedAttemptIndex: number) => {
	if (!shouldRetryConsume(kind)) {
		return undefined;
	}

	return CONSUME_RETRY_DELAYS_MS[failedAttemptIndex];
};

export { CONSUME_RETRY_DELAYS_MS, getConsumeRetryDelayMs, shouldRetryConsume };
