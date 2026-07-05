import { StreamKind } from '@sharkord/shared';

const CONSUME_RETRY_DELAYS_MS: readonly number[] = [500, 1_500, 3_000];

// After the fast initial retries, keep retrying on a slow tail. Audio kinds are
// mandatory streams with no manual re-accept path, so giving up after ~5s turns
// a transient server hiccup into permanent one-way silence. The tail keeps
// trying for roughly another minute before giving up for good.
const CONSUME_RETRY_TAIL_DELAY_MS = 10_000;
const CONSUME_RETRY_TAIL_ATTEMPTS = 6;
const CONSUME_RETRY_MAX_ATTEMPTS = CONSUME_RETRY_DELAYS_MS.length + CONSUME_RETRY_TAIL_ATTEMPTS;

const shouldRetryConsume = (kind: StreamKind) => {
	// EXTERNAL_VIDEO must retry (keeping its pending entry between attempts):
	// while the external track is present the provider auto-re-adds a missing
	// pending entry and auto-consumes it when watched, so dropping the entry on
	// failure creates a zero-delay add -> consume -> fail -> remove cycle.
	return (
		kind === StreamKind.AUDIO ||
		kind === StreamKind.SCREEN_AUDIO ||
		kind === StreamKind.EXTERNAL_AUDIO ||
		kind === StreamKind.EXTERNAL_VIDEO
	);
};

const getConsumeRetryDelayMs = (kind: StreamKind, failedAttemptIndex: number) => {
	if (!shouldRetryConsume(kind)) {
		return undefined;
	}

	if (failedAttemptIndex < CONSUME_RETRY_DELAYS_MS.length) {
		return CONSUME_RETRY_DELAYS_MS[failedAttemptIndex];
	}

	if (failedAttemptIndex < CONSUME_RETRY_MAX_ATTEMPTS) {
		return CONSUME_RETRY_TAIL_DELAY_MS;
	}

	return undefined;
};

export {
	CONSUME_RETRY_DELAYS_MS,
	CONSUME_RETRY_MAX_ATTEMPTS,
	CONSUME_RETRY_TAIL_DELAY_MS,
	getConsumeRetryDelayMs,
	shouldRetryConsume,
};
