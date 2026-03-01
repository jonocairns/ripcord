import type { TPinnedCard } from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import { store } from '@/features/store';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
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
import { serverSliceActions } from '../slice';
import { playSound } from '../sounds/actions';
import { SoundType } from '../types';
import { ownUserIdSelector } from '../users/selectors';
import { ownVoiceStateSelector } from './selectors';

type TLeaveVoiceOptions = {
  playOwnLeaveSound: boolean;
};

const channelHasAvailableStreams = (
  channelId: number,
  opts: { excludeUserId?: number } = {}
): boolean => {
  const state = store.getState();
  const users = state.server.voiceMap[channelId]?.users ?? {};
  const externalStreams = state.server.externalStreamsMap[channelId] ?? {};

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

export const addUserToVoiceChannel = (
  userId: number,
  channelId: number,
  voiceState: TVoiceUserState
): void => {
  const state = store.getState();
  const ownUserId = ownUserIdSelector(state);
  const currentChannelId = currentVoiceChannelIdSelector(state);

  store.dispatch(
    serverSliceActions.addUserToVoiceChannel({
      userId,
      channelId,
      state: voiceState
    })
  );

  if (userId !== ownUserId && channelId === currentChannelId) {
    playSound(SoundType.REMOTE_USER_JOINED_VOICE_CHANNEL);
  }
};

export const removeUserFromVoiceChannel = (
  userId: number,
  channelId: number
): void => {
  const state = store.getState();
  const ownUserId = ownUserIdSelector(state);
  const currentChannelId = currentVoiceChannelIdSelector(state);

  store.dispatch(
    serverSliceActions.removeUserFromVoiceChannel({ userId, channelId })
  );

  if (userId !== ownUserId && channelId === currentChannelId) {
    playSound(SoundType.REMOTE_USER_LEFT_VOICE_CHANNEL);
  }
};

export const addExternalStreamToVoiceChannel = (
  channelId: number,
  streamId: number,
  stream: TExternalStream
): void => {
  const state = store.getState();
  const currentChannelId = currentVoiceChannelIdSelector(state);
  const shouldPlayStartedStreamSound =
    channelId === currentChannelId && !channelHasAvailableStreams(channelId);

  store.dispatch(
    serverSliceActions.addExternalStreamToChannel({
      channelId,
      streamId,
      stream
    })
  );

  if (shouldPlayStartedStreamSound) {
    playSound(SoundType.REMOTE_USER_STARTED_STREAM);
  }
};

export const updateExternalStreamInVoiceChannel = (
  channelId: number,
  streamId: number,
  stream: TExternalStream
): void => {
  store.dispatch(
    serverSliceActions.updateExternalStreamInChannel({
      channelId,
      streamId,
      stream
    })
  );
};

export const removeExternalStreamFromVoiceChannel = (
  channelId: number,
  streamId: number
): void => {
  store.dispatch(
    serverSliceActions.removeExternalStreamFromChannel({
      channelId,
      streamId
    })
  );
};

export const updateVoiceUserState = (
  userId: number,
  channelId: number,
  newState: Partial<TVoiceUserState>
): void => {
  const state = store.getState();
  const currentChannelId = currentVoiceChannelIdSelector(state);
  const ownUserId = ownUserIdSelector(state);
  const currentUserState = state.server.voiceMap[channelId]?.users[userId];

  const shouldPlayStartedStreamSound =
    userId !== ownUserId &&
    channelId === currentChannelId &&
    !!currentUserState &&
    !channelHasAvailableStreams(channelId, { excludeUserId: userId }) &&
    ((newState.webcamEnabled === true && !currentUserState.webcamEnabled) ||
      (newState.sharingScreen === true && !currentUserState.sharingScreen));

  store.dispatch(
    serverSliceActions.updateVoiceUserState({ userId, channelId, newState })
  );

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
  store.dispatch(serverSliceActions.updateOwnVoiceState(newState));
};

export const joinVoice = async (
  channelId: number
): Promise<RtpCapabilities | undefined> => {
  const state = store.getState();
  const currentChannelId = currentVoiceChannelIdSelector(state);

  if (channelId === currentChannelId) {
    // already in the desired channel
    return undefined;
  }

  if (currentChannelId) {
    // is already in a voice channel, leave it first
    await leaveVoiceInternal({ playOwnLeaveSound: false });
  }

  setCurrentVoiceChannelId(channelId);

  const { micMuted, soundMuted } = ownVoiceStateSelector(state);
  const client = getTRPCClient();

  try {
    const { routerRtpCapabilities } = await client.voice.join.mutate({
      channelId,
      state: { micMuted, soundMuted }
    });

    return routerRtpCapabilities;
  } catch (error) {
    setCurrentVoiceChannelId(undefined);
    toast.error(getTrpcError(error, 'Failed to join voice channel'));
  }

  return undefined;
};

const leaveVoiceInternal = async (
  options: TLeaveVoiceOptions
): Promise<void> => {
  const state = store.getState();
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

export const setPinnedCard = (pinnedCard: TPinnedCard | undefined): void => {
  store.dispatch(serverSliceActions.setPinnedCard(pinnedCard));
};
