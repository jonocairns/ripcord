import { getFileUrl } from '@/helpers/get-file-url';
import type { EmojiItem } from '@tiptap/extension-emoji';
import type { IServerState } from '../slice';

let lastEmojisInput: IServerState['emojis'] | undefined;
let lastCustomEmojis: EmojiItem[] = [];

export const emojisSelector = (state: IServerState) => state.emojis;

export const customEmojisSelector = (state: IServerState) => {
  if (state.emojis === lastEmojisInput) {
    return lastCustomEmojis;
  }

  lastEmojisInput = state.emojis;
  lastCustomEmojis = state.emojis.map((emoji) => ({
    name: emoji.name,
    shortcodes: [emoji.name],
    tags: ['custom'],
    group: 'Custom',
    fallbackImage: getFileUrl(emoji.file)
  }));

  return lastCustomEmojis;
};
