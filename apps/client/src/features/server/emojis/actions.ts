import type { TJoinedEmoji } from '@sharkord/shared';
import { useServerStore } from '../slice';

export const setEmojis = (emojis: TJoinedEmoji[]) => {
  useServerStore.getState().setEmojis(emojis);
};

export const addEmoji = (emoji: TJoinedEmoji) => {
  useServerStore.getState().addEmoji(emoji);
};

export const updateEmoji = (emojiId: number, emoji: Partial<TJoinedEmoji>) => {
  useServerStore.getState().updateEmoji({ emojiId, emoji });
};

export const removeEmoji = (emojiId: number) => {
  useServerStore.getState().removeEmoji({ emojiId });
};
