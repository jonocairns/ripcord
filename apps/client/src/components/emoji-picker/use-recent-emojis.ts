import type { TEmojiItem } from '@/components/tiptap-input/types';
import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { useCallback, useSyncExternalStore } from 'react';

const MAX_RECENT_EMOJIS = 32;
const RECENT_EMOJIS_CHANGED_EVENT = 'sharkord:recent-emojis-changed';

type StoredEmoji = {
  name: string;
  shortcodes: string[];
  fallbackImage?: string;
  emoji?: string;
};

const loadRecentEmojis = (): TEmojiItem[] => {
  if (typeof window === 'undefined') {
    return [];
  }

  const stored = getLocalStorageItemAsJSON<StoredEmoji[]>(
    LocalStorageKey.RECENT_EMOJIS,
    []
  );

  return stored ?? [];
};

const saveRecentEmojis = (emojis: TEmojiItem[]): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const toStore: StoredEmoji[] = emojis.map((e) => ({
    name: e.name,
    shortcodes: e.shortcodes,
    fallbackImage: e.fallbackImage,
    emoji: e.emoji
  }));

  setLocalStorageItemAsJSON(LocalStorageKey.RECENT_EMOJIS, toStore);
  window.dispatchEvent(new Event(RECENT_EMOJIS_CHANGED_EVENT));
};

const addRecentEmoji = (emoji: TEmojiItem): void => {
  const current = loadRecentEmojis();

  const filtered = current.filter((e) => e.name !== emoji.name);
  const updated = [emoji, ...filtered].slice(0, MAX_RECENT_EMOJIS);

  saveRecentEmojis(updated);
};

const subscribe = (callback: () => void): (() => void) => {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const handleRecentEmojisChanged = () => callback();

  window.addEventListener(RECENT_EMOJIS_CHANGED_EVENT, handleRecentEmojisChanged);
  window.addEventListener('storage', handleRecentEmojisChanged);

  return () => {
    window.removeEventListener(
      RECENT_EMOJIS_CHANGED_EVENT,
      handleRecentEmojisChanged
    );
    window.removeEventListener('storage', handleRecentEmojisChanged);
  };
};

const getSnapshot = (): TEmojiItem[] => {
  return loadRecentEmojis();
};

const getServerSnapshot = (): TEmojiItem[] => [];

const useRecentEmojis = () => {
  const recentEmojis = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  );

  const addRecent = useCallback((emoji: TEmojiItem) => {
    addRecentEmoji(emoji);
  }, []);

  return {
    recentEmojis,
    addRecent
  };
};

export { addRecentEmoji, useRecentEmojis };
