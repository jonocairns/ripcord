import { Device } from 'mediasoup-client';
import { toast } from 'sonner';
import { useServerStore } from '@/features/server/slice';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import {
	clearOwnVoiceSessionAfterReconnectFailure,
	leaveVoiceSessionAfterRecoveryFailure,
	sendOwnVoiceStateUpdate,
	updateOwnVoiceState,
} from '@/features/server/voice/actions';
import { isVoiceReconnectOnline } from '@/features/server/voice/reconnect-lab-debug';
import { ownVoiceStateSelector } from '@/features/server/voice/selectors';
import type { TVoiceSessionExecutorPorts } from '@/features/server/voice/voice-session-command-executor';
import {
	dispatchVoiceSession,
	dispatchVoiceSessionWithResult,
	getVoiceSessionState,
} from '@/features/server/voice/voice-session-store';
import { logDebug, logVoice, reportError, traceSentrySpan } from '@/helpers/browser-logger';
import { getTrpcErrorData } from '@/helpers/trpc-error-data';
import { getTRPCClient, TRPCClientUnavailableError } from '@/lib/trpc';
import { voiceSessionCommandObserver } from './voice-session-command-observer';
import type { TVoiceSessionRuntimeDependencies } from './voice-session-runtime';

const RECOVERY_TIMEOUT_MS = 12_000;

const delayVoiceSessionCommand = (milliseconds: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}

		const timeoutId = window.setTimeout(() => {
			signal.removeEventListener('abort', handleAbort);
			resolve();
		}, milliseconds);
		const handleAbort = (): void => {
			window.clearTimeout(timeoutId);
			reject(signal.reason);
		};

		signal.addEventListener('abort', handleAbort, { once: true });
	});

const withTimeout = <T>(
	promise: Promise<T>,
	timeoutMs: number,
	createTimeoutError: () => Error,
	onTimeout?: () => void,
): Promise<T> => {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		handle = setTimeout(() => {
			onTimeout?.();
			reject(createTimeoutError());
		}, timeoutMs);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (handle !== undefined) {
			clearTimeout(handle);
		}
	});
};

const withRecoveryTimeout = <T>(promise: Promise<T>, onTimeout?: () => void): Promise<T> =>
	withTimeout(promise, RECOVERY_TIMEOUT_MS, () => new Error('Voice transport recovery timed out'), onTimeout);

const createReconnectAttemptId = (): string => {
	const randomUUID = globalThis.crypto?.randomUUID;
	if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto);
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const requestVoiceRestoreOrJoin = async (opts: {
	channelId: number;
	micMuted: boolean;
	soundMuted: boolean;
	reconnectAttemptId: string;
	signal?: AbortSignal;
}): ReturnType<TVoiceSessionRuntimeDependencies['requestVoiceRestoreOrJoin']> => {
	return traceSentrySpan(
		{
			name: 'voice.restore_or_join',
			op: 'voice.trpc',
			attributes: {
				'voice.reconnect_attempt_id': opts.reconnectAttemptId,
			},
		},
		() =>
			getTRPCClient().voice.restoreOrJoin.mutate(
				{
					channelId: opts.channelId,
					state: {
						micMuted: opts.micMuted,
						soundMuted: opts.soundMuted,
					},
					reconnectAttemptId: opts.reconnectAttemptId,
				},
				{ signal: opts.signal },
			),
	);
};

// Environment adapters retain the provider's existing signaling, reporting,
// timeout and producer-refresh timing. Construction performs no side effects.
const voiceSessionRuntimeEnvironment = {
	getServerState: useServerStore.getState,
	getOwnVoiceState: () => ownVoiceStateSelector(useServerStore.getState()),
	createDevice: () => Device.factory(),
	requestVoiceRestoreOrJoin,
	sendOwnVoiceStateUpdate,
	updateOwnVoiceState,
	clearOwnVoiceSessionAfterReconnectFailure,
	leaveVoiceSessionAfterRecoveryFailure,
	notifyConnectionLost: () => {
		playSound(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
		toast.info('Voice connection was lost. Rejoin the voice channel manually.');
	},
	dispatchVoiceSession,
	dispatchVoiceSessionWithResult,
	getVoiceSessionState,
	logVoice,
	logDebug,
	traceSentrySpan,
	now: Date.now,
	createReconnectAttemptId,
	getErrorCode: (error: unknown) => getTrpcErrorData(error)?.code,
	withRecoveryTimeout,
	waitForProducerRefresh: () => new Promise<void>((resolve) => setTimeout(resolve, 350)),
};

const voiceSessionRuntimeExecutorEnvironment = {
	commandObserver: voiceSessionCommandObserver,
	now: Date.now,
	random: Math.random,
	delay: delayVoiceSessionCommand,
	isOnline: isVoiceReconnectOnline,
	reportCommandError: (command, error) => {
		// A command that raced the socket going down is expected fallout of the
		// disconnect, not a command defect. The reconnect machinery already
		// reports when recovery actually gives up, so filing this too just
		// duplicates every drop under a misleading title.
		if (error instanceof TRPCClientUnavailableError) {
			logVoice('Voice session command skipped: server connection unavailable', {
				commandType: command.type,
				commandId: command.commandId,
				generation: command.generation,
			});
			return;
		}

		reportError('Voice session command failed', error, {
			commandType: command.type,
			commandId: command.commandId,
			generation: command.generation,
		});
	},
	reportRebuildDetached: (command) => {
		reportError('Voice transport rebuild detached a hung cancelled operation', new Error('Voice rebuild detached'), {
			commandType: command.type,
			commandId: command.commandId,
			generation: command.generation,
			phase: 'rebuilding',
			attempt: command.attempt + 1,
		});
	},
	reportRebuildTerminalFailure: (command, error) => {
		reportError('Voice transport recovery failed', error, {
			commandType: command.type,
			commandId: command.commandId,
			generation: command.generation,
			phase: 'rebuilding',
			attempt: command.attempt + 1,
		});
	},
	reportRestoreDetached: (command) => {
		reportError('Voice reconnect detached a hung cancelled operation', new Error('Voice restore detached'), {
			commandType: command.type,
			commandId: command.commandId,
			generation: command.generation,
			phase: 'restoring',
			attempt: command.attempt + 1,
		});
	},
} satisfies Pick<
	TVoiceSessionExecutorPorts,
	| 'commandObserver'
	| 'now'
	| 'random'
	| 'delay'
	| 'isOnline'
	| 'reportCommandError'
	| 'reportRebuildDetached'
	| 'reportRebuildTerminalFailure'
	| 'reportRestoreDetached'
>;

export { voiceSessionRuntimeEnvironment, voiceSessionRuntimeExecutorEnvironment };
