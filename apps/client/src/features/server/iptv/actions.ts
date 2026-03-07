import type { TIptvStatus } from '@sharkord/shared';
import { useServerStore } from '../slice';

export const setIptvStatus = (channelId: number, status: TIptvStatus): void => {
  useServerStore.getState().setIptvStatus({ channelId, status });
};

export const clearIptvStatus = (channelId: number): void => {
  useServerStore.getState().clearIptvStatus(channelId);
};
