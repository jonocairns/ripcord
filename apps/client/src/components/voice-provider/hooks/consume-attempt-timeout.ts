const CONSUME_ATTEMPT_RPC_TIMEOUT_MS = 10_000;

class VoiceConsumeAttemptTimeoutError extends Error {
	constructor() {
		super('Voice consume attempt timed out');
		this.name = 'VoiceConsumeAttemptTimeoutError';
	}
}

const withConsumeAttemptTimeout = <T>(
	promise: Promise<T>,
	timeoutMs: number = CONSUME_ATTEMPT_RPC_TIMEOUT_MS,
): Promise<T> => {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		handle = setTimeout(() => reject(new VoiceConsumeAttemptTimeoutError()), timeoutMs);
	});

	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (handle !== undefined) {
			clearTimeout(handle);
		}
	});
};

export { CONSUME_ATTEMPT_RPC_TIMEOUT_MS, VoiceConsumeAttemptTimeoutError, withConsumeAttemptTimeout };
