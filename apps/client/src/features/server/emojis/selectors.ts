import type { EmojiItem } from '@tiptap/extension-emoji';
import { getFileUrl } from '@/helpers/get-file-url';
import type { IServerState } from '../slice';

export const emojisSelector = (state: IServerState) => state.emojis;

export const toCustomEmojis = (emojis: IServerState['emojis']): EmojiItem[] => {
	return emojis.map((emoji) => ({
		name: emoji.name,
		shortcodes: [emoji.name],
		tags: ['custom'],
		group: 'Custom',
		fallbackImage: getFileUrl(emoji.file),
	}));
};
