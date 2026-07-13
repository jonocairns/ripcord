import { getTrpcErrorData } from '@/helpers/trpc-error-data';
import type { TClearReason } from './reconnect-coordinator';

const VOICE_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;
const VOICE_RECONNECT_JITTER_FACTOR = 0.2;
const MAX_UNKNOWN_RECONNECT_ERRORS = 3;

class VoiceReconnectTimeoutError extends Error {
	constructor() {
		super('Voice reconnect timed out');
		this.name = 'VoiceReconnectTimeoutError';
	}
}

type TVoiceReconnectErrorClassification =
	| {
			kind: 'retry';
			reason:
				| 'network-error'
				| 'rate-limited'
				| 'server-error'
				| 'timeout'
				| 'ws-1013'
				| 'unauthorized'
				| 'unknown-error';
			countsAsUnknown: boolean;
	  }
	| {
			kind: 'terminal';
			reason:
				| 'bad-request'
				| 'forbidden'
				| 'not-found'
				| 'restore-conflict'
				| 'unsupported-device'
				| 'unknown-error-cap';
			clearReason: TClearReason;
	  };

const classifyVoiceReconnectError = (
	error: unknown,
	opts: { consecutiveUnknownErrors: number },
): TVoiceReconnectErrorClassification => {
	const data = getTrpcErrorData(error);
	const errorMessage = getErrorMessage(error);
	const normalizedMessage = errorMessage.toLowerCase();
	const wsCloseCode =
		getNumericField(error, 'wsCloseCode') ?? getNumericField(error, 'closeCode') ?? getNumericField(error, 'code');

	switch (data?.code) {
		case 'BAD_REQUEST':
			return {
				kind: 'terminal',
				reason: 'bad-request',
				clearReason: 'restore-terminal-error',
			};
		case 'UNAUTHORIZED':
			// A reconnected socket is unauthenticated until joinServer re-auths it.
			// If a restore attempt still lands on an unauthenticated socket — e.g. the
			// WS dropped again mid-recovery and flushed the mutation onto the fresh
			// socket before its joinServer completed — that is transient, not fatal.
			// Retry and let the loop's auth gate + backoff pick it up once joinServer
			// re-authenticates, rather than terminally dropping the user from voice.
			return {
				kind: 'retry',
				reason: 'unauthorized',
				countsAsUnknown: false,
			};
		case 'FORBIDDEN':
			return {
				kind: 'terminal',
				reason: 'forbidden',
				clearReason: 'restore-terminal-error',
			};
		case 'NOT_FOUND':
			return {
				kind: 'terminal',
				reason: 'not-found',
				clearReason: 'restore-terminal-error',
			};
		case 'CONFLICT':
			return {
				kind: 'terminal',
				reason: 'restore-conflict',
				clearReason: 'restore-conflict',
			};
		case 'TOO_MANY_REQUESTS':
			return {
				kind: 'retry',
				reason: 'rate-limited',
				countsAsUnknown: false,
			};
		case 'INTERNAL_SERVER_ERROR':
			return {
				kind: 'retry',
				reason: 'server-error',
				countsAsUnknown: false,
			};
	}

	if (data?.httpStatus === 429) {
		return {
			kind: 'retry',
			reason: 'rate-limited',
			countsAsUnknown: false,
		};
	}

	if (typeof data?.httpStatus === 'number' && data.httpStatus >= 500) {
		return {
			kind: 'retry',
			reason: 'server-error',
			countsAsUnknown: false,
		};
	}

	if (error instanceof VoiceReconnectTimeoutError) {
		return {
			kind: 'retry',
			reason: 'timeout',
			countsAsUnknown: false,
		};
	}

	if (wsCloseCode === 1013) {
		return {
			kind: 'retry',
			reason: 'ws-1013',
			countsAsUnknown: false,
		};
	}

	if (isUnsupportedDeviceError(normalizedMessage)) {
		return {
			kind: 'terminal',
			reason: 'unsupported-device',
			clearReason: 'restore-terminal-error',
		};
	}

	if (looksLikeRetryableNetworkError(normalizedMessage)) {
		return {
			kind: 'retry',
			reason: 'network-error',
			countsAsUnknown: false,
		};
	}

	if (opts.consecutiveUnknownErrors + 1 >= MAX_UNKNOWN_RECONNECT_ERRORS) {
		return {
			kind: 'terminal',
			reason: 'unknown-error-cap',
			clearReason: 'restore-terminal-error',
		};
	}

	return {
		kind: 'retry',
		reason: 'unknown-error',
		countsAsUnknown: true,
	};
};

const getVoiceReconnectRetryDelayMs = (attempt: number, randomValue: number): number => {
	const baseDelay =
		VOICE_RECONNECT_BACKOFF_MS[Math.min(attempt, VOICE_RECONNECT_BACKOFF_MS.length - 1)] ??
		VOICE_RECONNECT_BACKOFF_MS[VOICE_RECONNECT_BACKOFF_MS.length - 1];
	const clampedRandomValue = Math.min(1, Math.max(0, randomValue));
	const jitter = (clampedRandomValue * 2 - 1) * VOICE_RECONNECT_JITTER_FACTOR;

	return Math.max(0, Math.round(baseDelay * (1 + jitter)));
};

const getErrorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}

	return '';
};

const getNumericField = (value: unknown, key: string): number | undefined => {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	const field = Reflect.get(value, key);

	return typeof field === 'number' ? field : undefined;
};

const looksLikeRetryableNetworkError = (message: string): boolean => {
	return (
		message.includes('network') ||
		message.includes('failed to fetch') ||
		message.includes('fetch failed') ||
		message.includes('websocket closed') ||
		message.includes('socket closed') ||
		message.includes('connection closed') ||
		message.includes('connection lost') ||
		message.includes('econnrefused') ||
		message.includes('etimedout')
	);
};

const isUnsupportedDeviceError = (message: string): boolean => {
	return (
		message.includes('unsupportederror') ||
		message.includes('media codec not supported') ||
		(message.includes('device.load()') && message.includes('unsupported'))
	);
};

export { classifyVoiceReconnectError, getVoiceReconnectRetryDelayMs, VoiceReconnectTimeoutError };
