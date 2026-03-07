import type { IServerState } from '../slice';

export const iptvStatusMapSelector = (state: IServerState) =>
  state.iptvStatusMap;

export const iptvStatusByChannelIdSelector = (
  state: IServerState,
  channelId: number
) => state.iptvStatusMap[channelId];
