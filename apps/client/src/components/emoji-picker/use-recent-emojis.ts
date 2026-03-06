import type { TEmojiItem } from '@/components/tiptap-input/types';
import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { useCallback, useSyncExternalStore } from 'react';

const MAX_RECENT_EMOJIS = 32;
const RECENT_EMOJIS_CHANGED_EVENT = 'sharkord:recent-emojis-changed';
const EMPTY_RECENT_EMOJIS: TEmojiItem[] = [];

type StoredEmoji = {
  name: string;
  shortcodes: string[];
  fallbackImage?: string;
  emoji?: string;
};

let recentEmojisCache: TEmojiItem[] | null = null;

const loadRecentEmojis = (): TEmojiItem[] => {
  if (typeof window === 'undefined') {
    return EMPTY_RECENT_EMOJIS;
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
  recentEmojisCache = emojis;
  window.dispatchEvent(new Event(RECENT_EMOJIS_CHANGED_EVENT));
};

const addRecentEmoji = (emoji: TEmojiItem): void => {
  const current = getSnapshot();

  const filtered = current.filter((e) => e.name !== emoji.name);
  const updated = [emoji, ...filtered].slice(0, MAX_RECENT_EMOJIS);

  saveRecentEmojis(updated);
};

const subscribe = (callback: () => void): (() => void) => {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const handleRecentEmojisChanged = () => {
    callback();
  };

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key !== null &&
      event.key !== LocalStorageKey.RECENT_EMOJIS
    ) {
      return;
    }

    recentEmojisCache = null;
    callback();
  };

  window.addEventListener(RECENT_EMOJIS_CHANGED_EVENT, handleRecentEmojisChanged);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(
      RECENT_EMOJIS_CHANGED_EVENT,
      handleRecentEmojisChanged
    );
    window.removeEventListener('storage', handleStorage);
  };
};

const getSnapshot = (): TEmojiItem[] => {
  if (recentEmojisCache !== null) {
    return recentEmojisCache;
  }

  recentEmojisCache = loadRecentEmojis();
  return recentEmojisCache;
};

const getServerSnapshot = (): TEmojiItem[] => EMPTY_RECENT_EMOJIS;

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
