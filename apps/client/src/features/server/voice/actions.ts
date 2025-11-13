import { store } from '@/features/store';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { type TVoiceUserState } from '@sharkord/shared';
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
import { ownVoiceStateSelector } from './selectors';

export const addUserToVoiceChannel = (
  userId: number,
  channelId: number,
  state: TVoiceUserState
): void => {
  store.dispatch(
    serverSliceActions.addUserToVoiceChannel({ userId, channelId, state })
  );
};

export const removeUserFromVoiceChannel = (
  userId: number,
  channelId: number
): void => {
  store.dispatch(
    serverSliceActions.removeUserFromVoiceChannel({ userId, channelId })
  );
};

export const updateVoiceUserState = (
  userId: number,
  channelId: number,
  newState: Partial<TVoiceUserState>
): void => {
  store.dispatch(
    serverSliceActions.updateVoiceUserState({ userId, channelId, newState })
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
    await leaveVoice();
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
    toast.error(getTrpcError(error, 'Failed to join voice channel'));
  }

  return undefined;
};

export const leaveVoice = async (): Promise<void> => {
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

  const client = getTRPCClient();

  try {
    await client.voice.leave.mutate();
  } catch (error) {
    toast.error(getTrpcError(error, 'Failed to leave voice channel'));
  }
};
