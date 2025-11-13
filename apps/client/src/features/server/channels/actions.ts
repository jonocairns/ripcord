import { store } from '@/features/store';
import type { TChannel } from '@sharkord/shared';
import { serverSliceActions } from '../slice';

export const setChannels = (channels: TChannel[]) => {
  store.dispatch(serverSliceActions.setChannels(channels));
};

export const setSelectedChannelId = (channelId: number | undefined) =>
  store.dispatch(serverSliceActions.setSelectedChannelId(channelId));

export const setCurrentVoiceChannelId = (channelId: number | undefined) =>
  store.dispatch(serverSliceActions.setCurrentVoiceChannelId(channelId));

export const addChannel = (channel: TChannel) => {
  store.dispatch(serverSliceActions.addChannel(channel));
};

export const updateChannel = (
  channelId: number,
  channel: Partial<TChannel>
) => {
  store.dispatch(serverSliceActions.updateChannel({ channelId, channel }));
};

export const removeChannel = (channelId: number) => {
  store.dispatch(serverSliceActions.removeChannel({ channelId }));
};
