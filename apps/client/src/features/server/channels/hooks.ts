import { useMemo } from 'react';
import { useServerStore } from '../slice';
import {
  channelByIdSelector,
  channelPermissionsByIdSelector,
  channelsSelector,
  currentVoiceChannelIdSelector,
  isCurrentVoiceChannelSelectedSelector,
  selectedChannelIdSelector,
  selectedChannelSelector,
  selectedChannelTypeSelector
} from './selectors';

export const useChannels = () => useServerStore(channelsSelector);

export const useChannelById = (channelId: number) =>
  useServerStore((state) => channelByIdSelector(state, channelId));

export const useChannelsByCategoryId = (categoryId: number) => {
  const channels = useServerStore(channelsSelector);

  return useMemo(
    () =>
      channels
        .filter((channel) => channel.categoryId === categoryId)
        .sort((a, b) => a.position - b.position),
    [categoryId, channels]
  );
};

export const useSelectedChannelId = () =>
  useServerStore(selectedChannelIdSelector);

export const useSelectedChannel = () => useServerStore(selectedChannelSelector);

export const useCurrentVoiceChannelId = () =>
  useServerStore(currentVoiceChannelIdSelector);

export const useIsCurrentVoiceChannelSelected = () =>
  useServerStore(isCurrentVoiceChannelSelectedSelector);

export const useChannelPermissionsById = (channelId: number) =>
  useServerStore((state) => channelPermissionsByIdSelector(state, channelId));

export const useSelectedChannelType = () =>
  useServerStore(selectedChannelTypeSelector);
