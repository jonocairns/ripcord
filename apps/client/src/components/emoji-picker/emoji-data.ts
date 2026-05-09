import type { EmojiItem } from '@tiptap/extension-emoji';
import { gitHubEmojis } from '@tiptap/extension-emoji';
import type { TEmojiItem } from '@/components/tiptap-input/types';

const EMOJI_CATEGORIES = [
	{ id: 'recent', label: 'Recent', icon: '🕐' },
	{ id: 'people & body', label: 'People', icon: '😀' },
	{ id: 'animals & nature', label: 'Nature', icon: '🐻' },
	{ id: 'food & drink', label: 'Food', icon: '🍕' },
	{ id: 'activities', label: 'Activities', icon: '⚽' },
	{ id: 'travel & places', label: 'Travel', icon: '✈️' },
	{ id: 'objects', label: 'Objects', icon: '💡' },
	{ id: 'symbols', label: 'Symbols', icon: '💕' },
	{ id: 'flags', label: 'Flags', icon: '🏳️' },
];

type EmojiCategoryId = (typeof EMOJI_CATEGORIES)[number]['id'];

const toTEmojiItem = (emoji: EmojiItem): TEmojiItem => ({
	name: emoji.name,
	shortcodes: emoji.shortcodes,
	fallbackImage: emoji.fallbackImage,
	emoji: emoji.emoji,
});

const processEmojis = () => {
	const grouped: Record<string, TEmojiItem[]> = {};
	const all: TEmojiItem[] = [];

	for (const category of EMOJI_CATEGORIES) {
		grouped[category.id] = [];
	}

	for (const emoji of gitHubEmojis) {
		if (!emoji.emoji) continue;
		if (emoji.group === 'components' || emoji.group === 'GitHub') continue;

		// tiptap's emoji data ships ~190 entries with an empty `group`. That bucket
		// mixes basic faces (:smile:, :grin:) with regional-indicator letters used
		// to compose flags. Tags are populated for the former and empty for the
		// latter, so use that to keep the indicators out of the picker while
		// recovering the faces into people & body.
		let groupKey: string;
		if (emoji.group && grouped[emoji.group]) {
			groupKey = emoji.group;
		} else if (emoji.tags && emoji.tags.length > 0) {
			groupKey = 'people & body';
		} else {
			continue;
		}

		const converted = toTEmojiItem(emoji);

		grouped[groupKey].push(converted);
		all.push(converted);
	}

	return { grouped, all };
};

const { grouped: GROUPED_EMOJIS, all: ALL_EMOJIS } = processEmojis();

const searchEmojis = (emojis: TEmojiItem[], query: string): TEmojiItem[] => {
	if (!query.trim()) return emojis;

	const lowerQuery = query.toLowerCase();

	return emojis.filter(
		(emoji) =>
			emoji.name.toLowerCase().includes(lowerQuery) ||
			emoji.shortcodes.some((sc) => sc.toLowerCase().includes(lowerQuery)),
	);
};

const getEmojisByCategory = (categoryId: EmojiCategoryId): TEmojiItem[] => GROUPED_EMOJIS[categoryId] || [];

const GRID_COLS = 8;

export {
	ALL_EMOJIS,
	EMOJI_CATEGORIES,
	type EmojiCategoryId,
	GRID_COLS,
	GROUPED_EMOJIS,
	getEmojisByCategory,
	searchEmojis,
	toTEmojiItem,
};
