import type { IServerState } from '../slice';

const DEFAULT_OBJECT = {};

export const channelsSelector = (state: IServerState) => state.channels;

export const selectedChannelIdSelector = (state: IServerState) =>
  state.selectedChannelId;

export const selectedChannelTypeSelector = (state: IServerState) =>
  state.channels.find((channel) => channel.id === state.selectedChannelId)?.type;

export const currentVoiceChannelIdSelector = (state: IServerState) =>
  state.currentVoiceChannelId;

export const channelPermissionsSelector = (state: IServerState) =>
  state.channelPermissions;

export const channelsReadStatesSelector = (state: IServerState) =>
  state.readStatesMap;

export const channelReadStateByIdSelector = (
  state: IServerState,
  channelId: number
) => state.readStatesMap[channelId] ?? 0;

export const channelByIdSelector = (state: IServerState, channelId: number) =>
  state.channels.find((channel) => channel.id === channelId);

export const channelsByCategoryIdSelector = (
  state: IServerState,
  categoryId: number
) =>
  state.channels
    .filter((channel) => channel.categoryId === categoryId)
    .sort((a, b) => a.position - b.position);

export const selectedChannelSelector = (state: IServerState) =>
  state.channels.find((channel) => channel.id === state.selectedChannelId);

export const isCurrentVoiceChannelSelectedSelector = (state: IServerState) =>
  state.currentVoiceChannelId !== undefined &&
  state.selectedChannelId === state.currentVoiceChannelId;

export const channelPermissionsByIdSelector = (
  state: IServerState,
  channelId: number
) => state.channelPermissions[channelId] || DEFAULT_OBJECT;
