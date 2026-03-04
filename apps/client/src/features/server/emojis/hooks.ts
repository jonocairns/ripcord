import { useServerStore } from '../slice';
import { customEmojisSelector } from './selectors';

export const useCustomEmojis = () => useServerStore(customEmojisSelector);
