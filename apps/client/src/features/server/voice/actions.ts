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
import { logDebug } from '@/helpers/browser-logger';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { isNonRetriableTrpcError } from '@/helpers/trpc-error-data';
import { getTRPCClient } from '@/lib/trpc';
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
} from './reconnect-coordinator';
import { ownVoiceStateSelector, pinnedCardSelector } from './selectors';

type TLeaveVoiceOptions = {
	playOwnLeaveSound: boolean;
	clearReconnectReason?: TClearReason | false;
	suppressErrors?: boolean;
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
		runVoiceProviderCleanup();
	}
};

const clearOwnVoiceSessionAfterReconnectFailure = (reason: TClearReason): void => {
	clearVoiceReconnectRecovery(reason);
	clearOwnVoiceChannelState();
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

	if (userId === ownUserId && channelId === currentChannelId) {
		if (opts.reconnecting) {
			captureVoiceReconnectIntentForCurrentSession();
			clearOwnVoiceChannelState();
		} else {
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

export const joinVoice = async (
	channelId: number,
	opts: {
		silent?: boolean;
	} = {},
): Promise<TJoinVoiceResult> => {
	const initialState = useServerStore.getState();
	const currentChannelId = currentVoiceChannelIdSelector(initialState);

	if (channelId === currentChannelId) {
		// already in the desired channel
		return { kind: 'already-joined' };
	}

	if (currentChannelId) {
		// is already in a voice channel, leave it first
		await leaveVoiceInternal({ playOwnLeaveSound: false });
	}

	const state = useServerStore.getState();
	const { micMuted, soundMuted } = ownVoiceStateSelector(state);
	const client = getTRPCClient();

	try {
		const { routerRtpCapabilities, producerTransportParams, consumerTransportParams, existingProducers, channelUsers } =
			await client.voice.join.mutate({
				channelId,
				state: { micMuted, soundMuted },
			});

		setCurrentVoiceChannelId(channelId);

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
		setCurrentVoiceChannelId(undefined);

		if (!opts.silent) {
			toast.error(getTrpcError(error, 'Failed to join voice channel'));
		}

		return {
			kind: isNonRetriableTrpcError(error) ? 'non-retriable-failure' : 'retryable-failure',
		};
	}
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

const leaveVoiceMutation = async (options: { suppressErrors?: boolean }): Promise<boolean> => {
	const client = getTRPCClient();

	try {
		await client.voice.leave.mutate();
		return true;
	} catch (error) {
		if (!options.suppressErrors) {
			toast.error(getTrpcError(error, 'Failed to leave voice channel'));
		}
		return false;
	}
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

export const handleVoiceSessionReplaced = (): void => {
	const state = useServerStore.getState();
	const currentChannelId = currentVoiceChannelIdSelector(state);

	if (!currentChannelId) {
		return;
	}

	clearVoiceReconnectRecovery('session-replaced');
	clearOwnVoiceChannelStateAndCleanupProvider();
};

export const setPinnedCard = (pinnedCard: TPinnedCard | undefined): void => {
	useServerStore.getState().setPinnedCard(pinnedCard);
};

export { clearOwnVoiceSessionAfterReconnectFailure };
