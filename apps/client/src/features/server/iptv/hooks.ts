import { useServerStore } from '../slice';
import {
  iptvStatusByChannelIdSelector,
  iptvStatusMapSelector
} from './selectors';

export const useIptvStatusMap = () => useServerStore(iptvStatusMapSelector);

export const useIptvStatusByChannelId = (channelId: number) =>
  useServerStore((state) => iptvStatusByChannelIdSelector(state, channelId));
