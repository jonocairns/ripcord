type TVoiceContext = Record<string, string | number | boolean>;

const enums: Record<string, readonly string[]> = {
	state: ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'],
	connectionState: ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'],
	iceState: ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed'],
	dtlsState: ['new', 'connecting', 'connected', 'failed', 'closed'],
	protocol: ['udp', 'tcp'],
	kind: ['audio', 'video', 'screen', 'screen_audio'],
	source: [
		'consumer-dtls',
		'producer-dtls',
		'media-liveness',
		'producer',
		'consumer',
		'microphone',
		'camera',
		'screen',
	],
	phase: [
		'idle',
		'joining',
		'connected',
		'rebuilding',
		'reconnecting',
		'failed',
		'waiting_online',
		'waiting_auth',
		'restoring',
		'retry_delay',
		'restore_watch',
		'connected_finalization',
		'failed_finalization',
	],
	outcome: ['succeeded', 'failed', 'expired', 'cancelled', 'superseded', 'detached'],
	commandType: [
		'CaptureRecoverySnapshot',
		'RebuildTransports',
		'WaitOnline',
		'WaitAuth',
		'RestoreVoiceSession',
		'RetryDelay',
		'RestoreWatchIntent',
		'RecoverDesktopAppAudio',
		'LeaveVoiceSession',
		'ClearFailedSession',
	],
	reason: [
		'user_action',
		'recovery_exhausted',
		'join_failed',
		'app_quit',
		'timeout',
		'recoverable_close',
		'terminal_close',
		'transport_cleanup',
		'transport_replaced',
		'producer_replaced',
		'consumer_replaced',
		'local_closed',
		'retry_exhausted',
		'publication_failed',
		'attempt_failed',
		'cancelled',
		'no_incoming_media',
		'no_decoding',
		'no_playback',
		'static_or_idle',
		'join-failed',
		'reconnect-expired',
		'recovery-exhausted',
	],
	mode: ['automatic', 'manual'],
};
const flags = new Set([
	'micMuted',
	'soundMuted',
	'webcamEnabled',
	'sharingScreen',
	'preserveLocalMedia',
	'preserveRemoteMediaIntent',
	'prefetched',
	'desired',
	'recoverable',
	'wasClean',
	'online',
	'wasConnected',
	'reconnect',
]);
const counters = new Set([
	'channelId',
	'userId',
	'remoteId',
	'commandId',
	'generation',
	'attempt',
	'retryAttempt',
	'rapidFailureCount',
	'taskCount',
	'producerCount',
	'consumerCount',
	'bytesReceived',
	'framesReceived',
	'framesDecoded',
	'framesRendered',
]);
const ids = new Set([
	'producerId',
	'consumerId',
	'transportId',
	'operationId',
	'reconnectAttemptId',
	'clientInstanceId',
]);
const errorTypes = new Set([
	'Error',
	'TypeError',
	'RangeError',
	'DOMException',
	'NotAllowedError',
	'NotReadableError',
	'NotFoundError',
	'AbortError',
	'NetworkError',
	'OverconstrainedError',
	'NotSupportedError',
	'InvalidStateError',
	'TRPCClientError',
]);
const errorCodes = new Set([
	'BAD_REQUEST',
	'UNAUTHORIZED',
	'FORBIDDEN',
	'NOT_FOUND',
	'TIMEOUT',
	'CONFLICT',
	'PRECONDITION_FAILED',
	'TOO_MANY_REQUESTS',
	'INTERNAL_SERVER_ERROR',
	'CLIENT_CLOSED_REQUEST',
	'METHOD_NOT_SUPPORTED',
	'NOT_IMPLEMENTED',
]);

// Closed keys and enum values, not a general-purpose object scrubber. In particular,
// never flatten tracks, labels, SDP, addresses, raw errors, or arbitrary state.
export const getVoiceDiagnosticContext = (args: readonly unknown[]): TVoiceContext => {
	const result: TVoiceContext = {};
	const visit = (value: unknown, nested = false) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return;
		for (const [key, entry] of Object.entries(value).slice(0, 40)) {
			const choices = Object.hasOwn(enums, key) ? enums[key] : undefined;
			if (ids.has(key) && typeof entry === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(entry)) result[key] = entry;
			else if (flags.has(key) && typeof entry === 'boolean') result[key] = entry;
			else if (
				counters.has(key) &&
				typeof entry === 'number' &&
				Number.isSafeInteger(entry) &&
				entry >= 0 &&
				entry <= Number.MAX_SAFE_INTEGER
			)
				result[key] = entry;
			else if (
				key === 'durationMs' &&
				typeof entry === 'number' &&
				Number.isFinite(entry) &&
				entry >= 0 &&
				entry <= 86_400_000
			)
				result[key] = entry;
			else if (
				key === 'closeCode' &&
				typeof entry === 'number' &&
				Number.isInteger(entry) &&
				entry >= 1000 &&
				entry <= 4999
			)
				result[key] = entry;
			else if (choices && typeof entry === 'string' && choices.includes(entry)) result[key] = entry;
			else if (!nested && ['failure', 'intent'].includes(key)) visit(entry, true);
			else if (key === 'error' && entry && typeof entry === 'object') {
				const name: unknown = Reflect.get(entry, 'name');
				if (typeof name === 'string' && errorTypes.has(name)) result.errorType = name;
				const data: unknown = Reflect.get(entry, 'data');
				const code: unknown = data && typeof data === 'object' ? Reflect.get(data, 'code') : undefined;
				if (typeof code === 'string' && errorCodes.has(code)) result.errorCode = code;
				const iceErrorCode: unknown = Reflect.get(entry, 'errorCode');
				if (
					typeof iceErrorCode === 'number' &&
					Number.isInteger(iceErrorCode) &&
					iceErrorCode >= 0 &&
					iceErrorCode <= 999
				)
					result.iceErrorCode = iceErrorCode;
			}
		}
	};
	for (const arg of args.slice(0, 8)) visit(arg);
	return Object.fromEntries(Object.entries(result).slice(0, 20));
};
