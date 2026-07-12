import {
	StreamKind,
	type TExternalStream,
	type TRemoteProducerIds,
	type TTransportParams,
	type TVoiceUserState,
} from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { toast } from 'sonner';
import type { TPinnedCard } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import { logDebug, logVoice, reportError } from '@/helpers/browser-logger';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { isNonRetriableTrpcError } from '@/helpers/trpc-error-data';
import { getTRPCClient, getWsClientInstanceId } from '@/lib/trpc';
import { setCurrentVoiceChannelId, setSelectedChannelId } from '../channels/actions';
import { currentVoiceChannelIdSelector, selectedChannelIdSelector } from '../channels/selectors';
import { useServerStore } from '../slice';
import { playSound } from '../sounds/actions';
import { SoundType } from '../types';
import { ownUserIdSelector } from '../users/selectors';
import { runVoiceProviderCleanup } from './provider-cleanup';
import type { TClearReason } from './reconnect-coordinator';
import {
	captureVoiceReconnectIntentForCurrentSession,
	clearVoiceReconnectRecovery,
	getValidPendingVoiceReconnect,
	isVoiceReconnectPeerSuppressed,
	isVoiceReconnectRecoveryActive,
} from './reconnect-coordinator';
import { ownVoiceStateSelector, pinnedCardSelector } from './selectors';

type TLeaveVoiceOptions = {
	playOwnLeaveSound: boolean;
	clearReconnectReason?: TClearReason | false;
	suppressErrors?: boolean;
};

const pendingVoiceSwitchFromChannelIds: Set<number> = new Set();
const completedVoiceSwitchFromChannelIds: Set<number> = new Set();
const pendingJoinAbortControllers: Set<AbortController> = new Set();
let voiceSessionMutationQueue: Promise<void> = Promise.resolve();
let joinVoiceGeneration = 0;
let voiceSessionMutationSeq = 0;

const enqueueVoiceSessionMutation = <Result>(mutation: () => Promise<Result>): Promise<Result> => {
	const result = voiceSessionMutationQueue.then(mutation);
	voiceSessionMutationQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
};

type TOwnVoiceStateUpdate = Partial<
	Pick<TVoiceUserState, 'micMuted' | 'soundMuted' | 'webcamEnabled' | 'sharingScreen'>
>;

let ownVoiceStateUpdateQueue: Promise<void> = Promise.resolve();
let ownVoiceStateUpdateSeq = 0;

// voice.updateState applies last-write-wins on the server after async
// permission checks, so two rapid updates can land out of order. Stamping a
// monotonic seq lets the server drop the stale write, and chaining the sends
// keeps ordering even against servers that predate the seq field.
export const sendOwnVoiceStateUpdate = (
	state: TOwnVoiceStateUpdate,
	options: { signal?: AbortSignal } = {},
): Promise<void> => {
	const seq = (ownVoiceStateUpdateSeq += 1);
	const result = ownVoiceStateUpdateQueue.then(() =>
		getTRPCClient().voice.updateState.mutate({ ...state, seq }, { signal: options.signal }),
	);
	ownVoiceStateUpdateQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
};

const resetVoiceSwitchState = (): void => {
	pendingVoiceSwitchFromChannelIds.clear();
	completedVoiceSwitchFromChannelIds.clear();
};

/** @knipignore Test-only reset for module-scoped voice switch bookkeeping. */
export const __resetVoiceSwitchStateForTests = (): void => {
	resetVoiceSwitchState();
	pendingJoinAbortControllers.clear();
	voiceSessionMutationQueue = Promise.resolve();
	joinVoiceGeneration = 0;
	voiceSessionMutationSeq = 0;
	ownVoiceStateUpdateQueue = Promise.resolve();
	ownVoiceStateUpdateSeq = 0;
};

const clearOwnVoiceChannelState = (): boolean => {
	const state = useServerStore.getState();
	const currentChannelId = currentVoiceChannelIdSelector(state);
	const selectedChannelId = selectedChannelIdSelector(state);
	const lastTextChannelId = state.lastTextChannelId;

	if (currentChannelId === undefined) {
		return false;
	}

	if (selectedChannelId === currentChannelId) {
		setSelectedChannelId(lastTextChannelId);
	}

	setCurrentVoiceChannelId(undefined);
	useServerStore.getState().updateOwnVoiceState({
		webcamEnabled: false,
		sharingScreen: false,
	});
	useServerStore.getState().setPinnedCard(undefined);

	return true;
};

const clearOwnVoiceChannelStateAndCleanupProvider = (): void => {
	if (clearOwnVoiceChannelState()) {
		resetVoiceSwitchState();
		runVoiceProviderCleanup();
	}
};

const clearOwnVoiceSessionAfterReconnectFailure = (reason: TClearReason): void => {
	const wasInVoice = currentVoiceChannelIdSelector(useServerStore.getState()) !== undefined;

	// Always surface why recovery gave up. Previously this only went through
	// logDebug (window.DEBUG-gated) and Sentry saw nothing, so a silent voice
	// drop left no trace in the logs the user actually captures.
	logVoice('Voice reconnect recovery gave up', { reason, wasInVoice });
	reportError('Voice reconnect recovery gave up', undefined, { reason, wasInVoice });

	clearVoiceReconnectRecovery(reason);
	clearOwnVoiceChannelState();
	resetVoiceSwitchState();
	runVoiceProviderCleanup();

	// Don't let the drop be silent: without this the mic/audio just stopped with
	// no sound and no UI, so the user had no idea they'd been dropped.
	if (wasInVoice) {
		playSound(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
		toast.error(getReconnectFailureToast(reason));
	}
};

const getReconnectFailureToast = (reason: TClearReason): string => {
	if (reason === 'restore-conflict') {
		return 'Your voice session was taken over by another connection. Rejoin to continue.';
	}

	return 'Lost the voice connection and could not automatically rejoin. Rejoin to continue.';
};

const channelHasAvailableStreams = (channelId: number, opts: { excludeUserId?: number } = {}): boolean => {
	const state = useServerStore.getState();
	const users = state.voiceMap[channelId]?.users ?? {};
	const externalStreams = state.externalStreamsMap[channelId] ?? {};

	const hasUserStream = Object.entries(users).some(([userId, voiceState]) => {
		if (opts.excludeUserId !== undefined && Number(userId) === opts.excludeUserId) {
			return false;
		}

		return voiceState.webcamEnabled || voiceState.sharingScreen;
	});

	return hasUserStream || Object.keys(externalStreams).length > 0;
};

const clearPinnedCardById = (cardId: string): void => {
	const pinnedCard = pinnedCardSelector(useServerStore.getState());

	if (pinnedCard?.id !== cardId) {
		return;
	}

	useServerStore.getState().setPinnedCard(undefined);
};

export const addUserToVoiceChannel = (
	userId: number,
	channelId: number,
	voiceState: TVoiceUserState,
	opts: { reconnecting?: boolean } = {},
): void => {
	const state = useServerStore.getState();
	const ownUserId = ownUserIdSelector(state);
	const currentChannelId = currentVoiceChannelIdSelector(state);

	useServerStore.getState().addUserToVoiceChannel({
		userId,
		channelId,
		state: voiceState,
	});

	if (
		userId !== ownUserId &&
		channelId === currentChannelId &&
		!opts.reconnecting &&
		!isVoiceReconnectPeerSuppressed(channelId, userId)
	) {
		playSound(SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL);
	}
};

export const removeUserFromVoiceChannel = (
	userId: number,
	channelId: number,
	opts: { reconnecting?: boolean } = {},
): void => {
	const state = useServerStore.getState();
	const ownUserId = ownUserIdSelector(state);
	const currentChannelId = currentVoiceChannelIdSelector(state);

	useServerStore.getState().removeUserFromVoiceChannel({ userId, channelId });

	clearPinnedCardById(`user-${userId}`);
	clearPinnedCardById(`screen-share-${userId}`);

	if (userId === ownUserId && pendingVoiceSwitchFromChannelIds.has(channelId)) {
		pendingVoiceSwitchFromChannelIds.delete(channelId);
		if (channelId === currentChannelId) {
			clearOwnVoiceChannelStateAndCleanupProvider();
		}
		return;
	}

	if (userId === ownUserId && channelId === currentChannelId) {
		if (opts.reconnecting) {
			captureVoiceReconnectIntentForCurrentSession();
			clearOwnVoiceChannelState();
		} else {
			// A locally initiated leave clears the channel state before the server
			// echo arrives, so reaching here means the server removed us.
			logVoice('Removed from voice channel by server', { channelId });
			playSound(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
			clearOwnVoiceChannelStateAndCleanupProvider();
		}
		return;
	}

	if (
		userId !== ownUserId &&
		channelId === currentChannelId &&
		!opts.reconnecting &&
		!isVoiceReconnectPeerSuppressed(channelId, userId)
	) {
		playSound(SoundType.REMOTE_USER_LEFT_VOICE_CHANNEL);
	}
};

export const addExternalStreamToVoiceChannel = (channelId: number, streamId: number, stream: TExternalStream): void => {
	const state = useServerStore.getState();
	const currentChannelId = currentVoiceChannelIdSelector(state);
	const shouldPlayStartedStreamSound = channelId === currentChannelId && !channelHasAvailableStreams(channelId);

	useServerStore.getState().addExternalStreamToChannel({
		channelId,
		streamId,
		stream,
	});

	if (shouldPlayStartedStreamSound) {
		playSound(SoundType.REMOTE_USER_STARTED_STREAM);
	}
};

export const updateExternalStreamInVoiceChannel = (
	channelId: number,
	streamId: number,
	stream: TExternalStream,
): void => {
	useServerStore.getState().updateExternalStreamInChannel({
		channelId,
		streamId,
		stream,
	});
};

export const removeExternalStreamFromVoiceChannel = (channelId: number, streamId: number): void => {
	useServerStore.getState().removeExternalStreamFromChannel({
		channelId,
		streamId,
	});

	clearPinnedCardById(`external-stream-${streamId}`);
};

export const updateVoiceUserState = (userId: number, channelId: number, newState: Partial<TVoiceUserState>): void => {
	const state = useServerStore.getState();
	const currentChannelId = currentVoiceChannelIdSelector(state);
	const ownUserId = ownUserIdSelector(state);
	const currentUserState = state.voiceMap[channelId]?.users[userId];

	const shouldPlayStartedStreamSound =
		userId !== ownUserId &&
		channelId === currentChannelId &&
		!!currentUserState &&
		!channelHasAvailableStreams(channelId, { excludeUserId: userId }) &&
		((newState.webcamEnabled === true && !currentUserState.webcamEnabled) ||
			(newState.sharingScreen === true && !currentUserState.sharingScreen));

	useServerStore.getState().updateVoiceUserState({
		userId,
		channelId,
		newState,
	});

	if (newState.sharingScreen === false) {
		clearPinnedCardById(`screen-share-${userId}`);
	}

	if (shouldPlayStartedStreamSound && !isVoiceReconnectPeerSuppressed(channelId, userId)) {
		playSound(SoundType.REMOTE_USER_STARTED_STREAM);
	}
};

export const handleStreamWatcherActivity = (activity: {
	watcherId: number;
	action: 'joined' | 'left';
	kind: StreamKind.VIDEO | StreamKind.SCREEN;
}): void => {
	playSound(activity.action === 'joined' ? SoundType.STREAM_WATCHER_JOINED : SoundType.STREAM_WATCHER_LEFT);

	if (activity.kind === StreamKind.SCREEN) {
		if (activity.action === 'joined') {
			useServerStore.getState().addScreenShareWatcher(activity.watcherId);
		} else {
			useServerStore.getState().removeScreenShareWatcher(activity.watcherId);
		}
	}
};

export const updateOwnVoiceState = (newState: Partial<TVoiceUserState>): void => {
	useServerStore.getState().updateOwnVoiceState(newState);
};

export type TJoinVoiceResult =
	| {
			kind: 'joined';
			routerRtpCapabilities: RtpCapabilities;
			producerTransportParams?: TTransportParams;
			consumerTransportParams?: TTransportParams;
			existingProducers?: TRemoteProducerIds;
	  }
	| {
			kind: 'already-joined';
	  }
	| {
			kind: 'retryable-failure';
	  }
	| {
			kind: 'non-retriable-failure';
	  };

const joinVoiceInternal = async (
	channelId: number,
	generation: number,
	mutationSeq: number,
	signal: AbortSignal,
	opts: {
		silent?: boolean;
	} = {},
): Promise<TJoinVoiceResult> => {
	const initialState = useServerStore.getState();
	const currentChannelId = currentVoiceChannelIdSelector(initialState);

	pendingVoiceSwitchFromChannelIds.delete(channelId);
	completedVoiceSwitchFromChannelIds.delete(channelId);

	if (channelId === currentChannelId) {
		// already in the desired channel
		return { kind: 'already-joined' };
	}

	if (currentChannelId) {
		// Keep the previous session locally until voice.join succeeds or the
		// server publishes the old-channel eviction. This preserves the old
		// membership if the target join fails before the server switch point.
		pendingVoiceSwitchFromChannelIds.add(currentChannelId);
	}

	const state = useServerStore.getState();
	const { micMuted, soundMuted } = ownVoiceStateSelector(state);
	const client = getTRPCClient();

	try {
		const { routerRtpCapabilities, producerTransportParams, consumerTransportParams, existingProducers, channelUsers } =
			await client.voice.join.mutate(
				{
					channelId,
					state: { micMuted, soundMuted },
					mutationSeq,
				},
				{ signal },
			);
		if (generation !== joinVoiceGeneration) {
			// The server still committed this join even though a newer local join
			// superseded it. Preserve the intermediate channel so the replacement
			// event emitted by the newer join cannot clear that newer session.
			completedVoiceSwitchFromChannelIds.add(channelId);
			return { kind: 'retryable-failure' };
		}

		setCurrentVoiceChannelId(channelId);
		if (currentChannelId) {
			pendingVoiceSwitchFromChannelIds.delete(currentChannelId);
			completedVoiceSwitchFromChannelIds.add(currentChannelId);
		}

		// Play the join sound at the moment the user visibly enters the channel,
		// decoupled from the media pipeline (transport/mic setup in init). The
		// sound and the visible "you're in the channel" state should not wait for
		// WebRTC to finish connecting.
		playSound(SoundType.OWN_USER_JOINED_VOICE_CHANNEL);

		// Reconcile the voiceMap with the server's authoritative channel state.
		// setInitialData (called during WS reconnect) takes a snapshot that may be
		// stale — users who joined between the snapshot and now would be invisible.
		// Overwriting with the join response's channel list guarantees we have the
		// correct set of participants the moment we enter the channel.
		useServerStore.getState().reconcileVoiceChannelUsers({ channelId, users: channelUsers });

		return {
			kind: 'joined',
			routerRtpCapabilities,
			producerTransportParams,
			consumerTransportParams,
			existingProducers,
		};
	} catch (error) {
		if (!currentChannelId) {
			setCurrentVoiceChannelId(undefined);
		}

		if (currentChannelId) {
			pendingVoiceSwitchFromChannelIds.delete(currentChannelId);
			completedVoiceSwitchFromChannelIds.delete(currentChannelId);
		}

		if (!opts.silent && !signal.aborted) {
			toast.error(getTrpcError(error, 'Failed to join voice channel'));
		}

		return {
			kind: isNonRetriableTrpcError(error) ? 'non-retriable-failure' : 'retryable-failure',
		};
	}
};

export const joinVoice = (
	channelId: number,
	opts: {
		silent?: boolean;
	} = {},
): Promise<TJoinVoiceResult> => {
	// A manual join replaces reconnect intent. Invalidate the recovery command
	// before enqueuing the join so an in-flight restore is aborted and cannot
	// later enqueue a terminal leave behind the user's new session.
	if (isVoiceReconnectRecoveryActive()) {
		clearVoiceReconnectRecovery('user-started-voice-join');
	}

	const generation = (joinVoiceGeneration += 1);
	const mutationSeq = (voiceSessionMutationSeq += 1);
	const abortController = new AbortController();
	pendingJoinAbortControllers.add(abortController);

	const result = enqueueVoiceSessionMutation(() =>
		joinVoiceInternal(channelId, generation, mutationSeq, abortController.signal, opts),
	);
	const releaseAbortController = (): void => {
		pendingJoinAbortControllers.delete(abortController);
	};
	void result.then(releaseAbortController, releaseAbortController);

	return result;
};

const leaveVoiceInternal = async (options: TLeaveVoiceOptions): Promise<boolean> => {
	const state = useServerStore.getState();
	const currentChannelId = currentVoiceChannelIdSelector(state);

	if (!currentChannelId) {
		return false;
	}

	if (options.clearReconnectReason !== false) {
		clearVoiceReconnectRecovery(options.clearReconnectReason ?? 'user-left-voice');
	}
	clearOwnVoiceChannelStateAndCleanupProvider();

	if (options.playOwnLeaveSound) {
		playSound(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
	}

	return leaveVoiceMutation({
		suppressErrors: options.suppressErrors,
	});
};

const leaveVoiceMutation = (options: { suppressErrors?: boolean }): Promise<boolean> => {
	// The newer server-visible sequence prevents an already-sent join from
	// committing after this leave, so aborting its client wait is safe and lets
	// the leave reach the server without waiting for a superseded request.
	joinVoiceGeneration += 1;
	const mutationSeq = (voiceSessionMutationSeq += 1);
	for (const abortController of pendingJoinAbortControllers) {
		abortController.abort();
	}

	const result = (async () => {
		const client = getTRPCClient();

		try {
			await client.voice.leave.mutate({ mutationSeq });
			return true;
		} catch (error) {
			if (!options.suppressErrors) {
				toast.error(getTrpcError(error, 'Failed to leave voice channel'));
			}
			return false;
		}
	})();
	voiceSessionMutationQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
};

const leaveVoiceSessionAfterRecoveryFailure = (): Promise<boolean> => {
	// A leave queued on a dead socket would flush whenever the WS reconnects
	// and race whatever session the user establishes by then. When the give-up
	// happens offline the server's disconnect grace reaps the seat instead.
	if (!useServerStore.getState().connected) {
		return Promise.resolve(false);
	}

	return leaveVoiceMutation({
		suppressErrors: true,
	});
};

export const leaveVoice = async (): Promise<void> => {
	await leaveVoiceInternal({ playOwnLeaveSound: true });
};

export const leaveVoiceSilently = async (): Promise<void> => {
	await leaveVoiceInternal({ playOwnLeaveSound: false });
};

export const flushVoiceForDesktopQuit = async (): Promise<'skipped' | 'succeeded'> => {
	const currentChannelId = currentVoiceChannelIdSelector(useServerStore.getState());
	const pendingVoiceReconnect = getValidPendingVoiceReconnect();
	const channelIdToFlush = currentChannelId ?? pendingVoiceReconnect?.channelId;

	clearVoiceReconnectRecovery('desktop-quit');

	if (channelIdToFlush === undefined) {
		logDebug('Desktop quit flush skipped', {
			reason: 'not-in-voice',
		});
		return 'skipped';
	}

	try {
		const didLeave =
			currentChannelId !== undefined
				? await leaveVoiceInternal({
						playOwnLeaveSound: false,
						clearReconnectReason: false,
						suppressErrors: true,
					})
				: await leaveVoiceMutation({
						suppressErrors: true,
					});

		if (!didLeave) {
			logDebug('Desktop quit flush skipped', {
				channelId: channelIdToFlush,
				reason: 'voice-leave-failed',
			});
			return 'skipped';
		}

		logDebug('Desktop quit flush succeeded', {
			channelId: channelIdToFlush,
		});
		return 'succeeded';
	} catch (error) {
		logDebug('Desktop quit flush skipped', {
			channelId: channelIdToFlush,
			reason: 'voice-leave-failed',
			error,
		});
		return 'skipped';
	}
};

export const handleVoiceSessionReplaced = (payload?: {
	channelId: number;
	replacedByClientInstanceId?: string;
}): void => {
	// The event fans out to every connection of the user, including the one
	// whose join caused the replacement. Today the replacer is protected only
	// by frame ordering (the event lands before its join response applies);
	// this makes ignoring it deterministic.
	if (
		payload?.replacedByClientInstanceId !== undefined &&
		payload.replacedByClientInstanceId === getWsClientInstanceId()
	) {
		return;
	}

	if (
		payload?.channelId !== undefined &&
		(pendingVoiceSwitchFromChannelIds.has(payload.channelId) ||
			completedVoiceSwitchFromChannelIds.has(payload.channelId))
	) {
		const currentChannelId = currentVoiceChannelIdSelector(useServerStore.getState());
		if (pendingVoiceSwitchFromChannelIds.has(payload.channelId) && currentChannelId !== payload.channelId) {
			pendingVoiceSwitchFromChannelIds.delete(payload.channelId);
		}
		if (completedVoiceSwitchFromChannelIds.has(payload.channelId)) {
			completedVoiceSwitchFromChannelIds.delete(payload.channelId);
		}
		return;
	}

	const state = useServerStore.getState();
	const currentChannelId = currentVoiceChannelIdSelector(state);
	// The replacement's own-leave event (reconnecting: true) usually arrives
	// first, clearing the channel state and capturing reconnect intent for the
	// replaced channel. That intent is what proves this connection held the
	// session that was just taken over — and it must be cleared, or a later WS
	// drop would try to restore into a channel another connection now owns.
	const pendingReconnectChannelId = getValidPendingVoiceReconnect()?.channelId;
	const heldReplacedSession =
		currentChannelId !== undefined ||
		(payload?.channelId !== undefined && pendingReconnectChannelId === payload.channelId);

	if (!heldReplacedSession) {
		return;
	}

	logVoice('Voice session replaced by another connection', { channelId: currentChannelId ?? payload?.channelId });
	clearVoiceReconnectRecovery('session-replaced');
	resetVoiceSwitchState();
	clearOwnVoiceChannelStateAndCleanupProvider();
	// Without this the replaced connection drops out of voice with no
	// explanation — the join sound plays on the new connection, not here.
	toast.info('Voice moved to another window or device.');
};

export const setPinnedCard = (pinnedCard: TPinnedCard | undefined): void => {
	useServerStore.getState().setPinnedCard(pinnedCard);
};

export { clearOwnVoiceSessionAfterReconnectFailure, leaveVoiceSessionAfterRecoveryFailure };
