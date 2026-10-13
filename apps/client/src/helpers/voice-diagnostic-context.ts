import { StreamKind, type TVoiceTransportFailureSource } from '@sharkord/shared';
import type {
	TVoiceSessionCommandOutcome,
	TVoiceSessionCommandPhase,
} from '@/features/server/voice/voice-session-command-executor';
import type { TVoiceSessionCommand, TVoiceSessionState } from '@/features/server/voice/voice-session-machine';

type TVoiceContext = Record<string, string | number | boolean>;

// Exhaustive maps keep privacy-approved vocabularies tied to their owning domain
// types. Adding/removing a domain value fails type checking until reviewed here.
const connectionStates = {
	new: true,
	connecting: true,
	connected: true,
	disconnected: true,
	failed: true,
	closed: true,
} satisfies Record<RTCPeerConnectionState, true>;
const iceStates = {
	new: true,
	checking: true,
	connected: true,
	completed: true,
	disconnected: true,
	failed: true,
	closed: true,
} satisfies Record<RTCIceTransportState, true>;
const dtlsStates = {
	new: true,
	connecting: true,
	connected: true,
	failed: true,
	closed: true,
} satisfies Record<RTCDtlsTransportState, true>;
const failureSources = {
	'consumer-dtls': true,
	'producer-dtls': true,
	'media-liveness': true,
} satisfies Record<TVoiceTransportFailureSource, true>;
const phases = {
	idle: true,
	joining: true,
	connected: true,
	rebuilding: true,
	reconnecting: true,
	failed: true,
	waiting_online: true,
	waiting_auth: true,
	restoring: true,
	retry_delay: true,
	restore_watch: true,
	connected_finalization: true,
	failed_finalization: true,
} satisfies Record<TVoiceSessionState['phase']['phase'] | TVoiceSessionCommandPhase, true>;
const outcomes = {
	succeeded: true,
	failed: true,
	expired: true,
	cancelled: true,
	superseded: true,
	detached: true,
} satisfies Record<TVoiceSessionCommandOutcome, true>;
const commandTypes = {
	CaptureRecoverySnapshot: true,
	RebuildTransports: true,
	WaitOnline: true,
	WaitAuth: true,
	RestoreVoiceSession: true,
	RetryDelay: true,
	RestoreWatchIntent: true,
	RecoverDesktopAppAudio: true,
	LeaveVoiceSession: true,
	ClearFailedSession: true,
} satisfies Record<TVoiceSessionCommand['type'], true>;

const enums: Record<string, readonly string[]> = {
	state: Object.keys(connectionStates),
	connectionState: Object.keys(connectionStates),
	iceState: Object.keys(iceStates),
	dtlsState: Object.keys(dtlsStates),
	protocol: ['udp', 'tcp'],
	kind: Object.values(StreamKind),
	source: [...Object.keys(failureSources), 'producer', 'consumer', 'microphone', 'camera', 'screen'],
	phase: Object.keys(phases),
	outcome: Object.keys(outcomes),
	commandType: Object.keys(commandTypes),
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
