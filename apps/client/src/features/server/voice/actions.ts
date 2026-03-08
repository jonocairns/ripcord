import type { TPinnedCard } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { isNonRetriableTrpcError } from '@/helpers/trpc-error-data';
import { getTRPCClient } from '@/lib/trpc';
import { type TExternalStream, type TVoiceUserState } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { toast } from 'sonner';
import {
  setCurrentVoiceChannelId,
  setSelectedChannelId
} from '../channels/actions';
import {
  currentVoiceChannelIdSelector,
  selectedChannelIdSelector
} from '../channels/selectors';
import { useServerStore } from '../slice';
import { playSound } from '../sounds/actions';
import { SoundType } from '../types';
import { ownUserIdSelector } from '../users/selectors';
import { ownVoiceStateSelector, pinnedCardSelector } from './selectors';

type TLeaveVoiceOptions = {
  playOwnLeaveSound: boolean;
};

const channelHasAvailableStreams = (
  channelId: number,
  opts: { excludeUserId?: number } = {}
): boolean => {
  const state = useServerStore.getState();
  const users = state.voiceMap[channelId]?.users ?? {};
  const externalStreams = state.externalStreamsMap[channelId] ?? {};

  const hasUserStream = Object.entries(users).some(([userId, voiceState]) => {
    if (
      opts.excludeUserId !== undefined &&
      Number(userId) === opts.excludeUserId
    ) {
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
  voiceState: TVoiceUserState
): void => {
  const state = useServerStore.getState();
  const ownUserId = ownUserIdSelector(state);
  const currentChannelId = currentVoiceChannelIdSelector(state);

  useServerStore.getState().addUserToVoiceChannel({
    userId,
    channelId,
    state: voiceState
  });

  if (userId !== ownUserId && channelId === currentChannelId) {
    playSound(SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL);
  }
};

export const removeUserFromVoiceChannel = (
  userId: number,
  channelId: number
): void => {
  const state = useServerStore.getState();
  const ownUserId = ownUserIdSelector(state);
  const currentChannelId = currentVoiceChannelIdSelector(state);

  useServerStore.getState().removeUserFromVoiceChannel({ userId, channelId });

  clearPinnedCardById(`user-${userId}`);
  clearPinnedCardById(`screen-share-${userId}`);

  if (userId !== ownUserId && channelId === currentChannelId) {
    playSound(SoundType.REMOTE_USER_LEFT_VOICE_CHANNEL);
  }
};

export const addExternalStreamToVoiceChannel = (
  channelId: number,
  streamId: number,
  stream: TExternalStream
): void => {
  const state = useServerStore.getState();
  const currentChannelId = currentVoiceChannelIdSelector(state);
  const shouldPlayStartedStreamSound =
    channelId === currentChannelId && !channelHasAvailableStreams(channelId);

  useServerStore.getState().addExternalStreamToChannel({
    channelId,
    streamId,
    stream
  });

  if (shouldPlayStartedStreamSound) {
    playSound(SoundType.REMOTE_USER_STARTED_STREAM);
  }
};

export const updateExternalStreamInVoiceChannel = (
  channelId: number,
  streamId: number,
  stream: TExternalStream
): void => {
  useServerStore.getState().updateExternalStreamInChannel({
    channelId,
    streamId,
    stream
  });
};

export const removeExternalStreamFromVoiceChannel = (
  channelId: number,
  streamId: number
): void => {
  useServerStore.getState().removeExternalStreamFromChannel({
    channelId,
    streamId
  });

  clearPinnedCardById(`external-stream-${streamId}`);
};

export const updateVoiceUserState = (
  userId: number,
  channelId: number,
  newState: Partial<TVoiceUserState>
): void => {
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
    newState
  });

  if (newState.sharingScreen === false) {
    clearPinnedCardById(`screen-share-${userId}`);
  }

  if (shouldPlayStartedStreamSound) {
    playSound(SoundType.REMOTE_USER_STARTED_STREAM);
  }
};

export const handleStreamWatcherActivity = (activity: {
  action: 'joined' | 'left';
}): void => {
  playSound(
    activity.action === 'joined'
      ? SoundType.STREAM_WATCHER_JOINED
      : SoundType.STREAM_WATCHER_LEFT
  );
};

export const updateOwnVoiceState = (
  newState: Partial<TVoiceUserState>
): void => {
  useServerStore.getState().updateOwnVoiceState(newState);
};

export type TJoinVoiceResult =
  | {
      kind: 'joined';
      routerRtpCapabilities: RtpCapabilities;
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
  } = {}
): Promise<TJoinVoiceResult> => {
  const state = useServerStore.getState();
  const currentChannelId = currentVoiceChannelIdSelector(state);

  if (channelId === currentChannelId) {
    // already in the desired channel
    return { kind: 'already-joined' };
  }

  if (currentChannelId) {
    // is already in a voice channel, leave it first
    await leaveVoiceInternal({ playOwnLeaveSound: false });
  }

  const { micMuted, soundMuted } = ownVoiceStateSelector(state);
  const client = getTRPCClient();

  try {
    const { routerRtpCapabilities } = await client.voice.join.mutate({
      channelId,
      state: { micMuted, soundMuted }
    });

    setCurrentVoiceChannelId(channelId);

    return {
      kind: 'joined',
      routerRtpCapabilities
    };
  } catch (error) {
    setCurrentVoiceChannelId(undefined);

    if (!opts.silent) {
      toast.error(getTrpcError(error, 'Failed to join voice channel'));
    }

    return {
      kind: isNonRetriableTrpcError(error)
        ? 'non-retriable-failure'
        : 'retryable-failure'
    };
  }
};

const leaveVoiceInternal = async (
  options: TLeaveVoiceOptions
): Promise<void> => {
  const state = useServerStore.getState();
  const currentChannelId = currentVoiceChannelIdSelector(state);
  const selectedChannelId = selectedChannelIdSelector(state);

  if (!currentChannelId) {
    return;
  }

  if (selectedChannelId === currentChannelId) {
    setSelectedChannelId(undefined);
  }

  setCurrentVoiceChannelId(undefined);
  updateOwnVoiceState({ webcamEnabled: false, sharingScreen: false });
  setPinnedCard(undefined);

  if (options.playOwnLeaveSound) {
    playSound(SoundType.OWN_USER_LEFT_VOICE_CHANNEL);
  }

  const client = getTRPCClient();

  try {
    await client.voice.leave.mutate();
  } catch (error) {
    toast.error(getTrpcError(error, 'Failed to leave voice channel'));
  }
};

export const leaveVoice = async (): Promise<void> => {
  await leaveVoiceInternal({ playOwnLeaveSound: true });
};

export const leaveVoiceSilently = async (): Promise<void> => {
  await leaveVoiceInternal({ playOwnLeaveSound: false });
};

export const setPinnedCard = (pinnedCard: TPinnedCard | undefined): void => {
  useServerStore.getState().setPinnedCard(pinnedCard);
};
