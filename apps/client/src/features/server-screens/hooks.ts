import { serverScreensInfoSelector } from './selectors';
import { useServerScreensStore } from './slice';

export const useServerScreenInfo = () =>
  useServerScreensStore(serverScreensInfoSelector);
