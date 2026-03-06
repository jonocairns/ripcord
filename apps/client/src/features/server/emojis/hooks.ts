import { useMemo } from 'react';
import { useServerStore } from '../slice';
import { emojisSelector, toCustomEmojis } from './selectors';

export const useCustomEmojis = () => {
  const emojis = useServerStore(emojisSelector);

  return useMemo(() => toCustomEmojis(emojis), [emojis]);
};
