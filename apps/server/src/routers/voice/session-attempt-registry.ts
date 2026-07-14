type TVoiceSessionAttemptStatus = 'current' | 'cancelled' | 'superseded';

type TVoiceSessionAttempt = {
	status: TVoiceSessionAttemptStatus;
};

type TVoiceSessionAttemptContext = {
	assertCurrent: () => void;
};

type TVoiceSessionAttemptRegistry = {
	runLatest: <T>(
		owner: unknown,
		signal: AbortSignal | undefined,
		run: (context: TVoiceSessionAttemptContext) => Promise<T>,
	) => Promise<T>;
	supersede: (owner: unknown) => void;
};

class VoiceSessionAttemptCancelledError extends Error {
	constructor() {
		super('Voice session attempt cancelled');
		this.name = 'VoiceSessionAttemptCancelledError';
	}
}

class VoiceSessionAttemptSupersededError extends Error {
	constructor() {
		super('Voice session attempt superseded');
		this.name = 'VoiceSessionAttemptSupersededError';
	}
}

const createVoiceSessionAttemptRegistry = (): TVoiceSessionAttemptRegistry => {
	const latestAttemptByOwner = new Map<unknown, TVoiceSessionAttempt>();

	const supersede = (owner: unknown) => {
		const attempt = latestAttemptByOwner.get(owner);

		if (attempt?.status === 'current') {
			attempt.status = 'superseded';
		}
	};

	const runLatest: TVoiceSessionAttemptRegistry['runLatest'] = async (owner, signal, run) => {
		supersede(owner);

		const attempt: TVoiceSessionAttempt = { status: 'current' };
		latestAttemptByOwner.set(owner, attempt);

		const cancel = () => {
			if (attempt.status !== 'current') {
				return;
			}

			attempt.status = 'cancelled';

			if (latestAttemptByOwner.get(owner) === attempt) {
				latestAttemptByOwner.delete(owner);
			}
		};

		if (signal?.aborted) {
			cancel();
		} else {
			signal?.addEventListener('abort', cancel, { once: true });
		}

		const getStatus = (): TVoiceSessionAttemptStatus => {
			if (attempt.status === 'current' && signal?.aborted) {
				cancel();
			}

			if (attempt.status === 'current' && latestAttemptByOwner.get(owner) !== attempt) {
				attempt.status = 'superseded';
			}

			return attempt.status;
		};

		const context: TVoiceSessionAttemptContext = {
			assertCurrent: () => {
				switch (getStatus()) {
					case 'cancelled':
						throw new VoiceSessionAttemptCancelledError();
					case 'superseded':
						throw new VoiceSessionAttemptSupersededError();
					case 'current':
						return;
				}
			},
		};

		try {
			return await run(context);
		} finally {
			signal?.removeEventListener('abort', cancel);

			if (latestAttemptByOwner.get(owner) === attempt) {
				latestAttemptByOwner.delete(owner);
			}
		}
	};

	return { runLatest, supersede };
};

const getVoiceSessionAttemptOwner = (
	userId: number,
	clientInstanceId: string | undefined,
	connectionIdentity: unknown,
) => {
	return clientInstanceId ? `${userId}:${clientInstanceId}` : (connectionIdentity ?? `${userId}:unknown-client`);
};

const voiceSessionAttemptRegistry = createVoiceSessionAttemptRegistry();

export type { TVoiceSessionAttemptContext, TVoiceSessionAttemptRegistry };
export {
	createVoiceSessionAttemptRegistry,
	getVoiceSessionAttemptOwner,
	VoiceSessionAttemptCancelledError,
	VoiceSessionAttemptSupersededError,
	voiceSessionAttemptRegistry,
};
