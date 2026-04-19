import type { MediaPlayerInstance } from '@vidstack/react';
import { useEffect, useSyncExternalStore, type RefObject } from 'react';

const SHARED_MEDIA_STORAGE_KEY = 'ripcord-media';
const SHARED_MEDIA_PREFERENCES_UPDATED_EVENT = 'sharkord:shared-media-preferences-updated';

type TSharedMediaPreferences = {
	volume: number;
	muted: boolean;
};

const DEFAULT_SHARED_MEDIA_PREFERENCES: TSharedMediaPreferences = {
	volume: 1,
	muted: false,
};

let sharedMediaPreferencesCache: TSharedMediaPreferences | null = null;

const isObject = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null;
};

const clampVolume = (volume: number): number => {
	return Math.min(1, Math.max(0, volume));
};

const normalizePreferences = (value: unknown): TSharedMediaPreferences => {
	if (!isObject(value)) {
		return DEFAULT_SHARED_MEDIA_PREFERENCES;
	}

	const volume = typeof value.volume === 'number' ? clampVolume(value.volume) : DEFAULT_SHARED_MEDIA_PREFERENCES.volume;
	const muted = typeof value.muted === 'boolean' ? value.muted : DEFAULT_SHARED_MEDIA_PREFERENCES.muted;

	return {
		volume,
		muted,
	};
};

const getEventPreferences = (event: Event): TSharedMediaPreferences | null => {
	if (!(event instanceof CustomEvent)) {
		return null;
	}

	return normalizePreferences(event.detail);
};

const loadSharedMediaPreferences = (): TSharedMediaPreferences => {
	if (typeof window === 'undefined') {
		return DEFAULT_SHARED_MEDIA_PREFERENCES;
	}

	try {
		const stored = window.localStorage.getItem(SHARED_MEDIA_STORAGE_KEY);

		if (!stored) {
			return DEFAULT_SHARED_MEDIA_PREFERENCES;
		}

		return normalizePreferences(JSON.parse(stored));
	} catch {
		return DEFAULT_SHARED_MEDIA_PREFERENCES;
	}
};

const saveSharedMediaPreferences = (preferences: TSharedMediaPreferences): void => {
	if (typeof window === 'undefined') {
		return;
	}

	try {
		const stored = window.localStorage.getItem(SHARED_MEDIA_STORAGE_KEY);
		const parsed = stored ? JSON.parse(stored) : {};
		const nextValue = isObject(parsed) ? parsed : {};

		window.localStorage.setItem(
			SHARED_MEDIA_STORAGE_KEY,
			JSON.stringify({
				...nextValue,
				volume: preferences.volume,
				muted: preferences.muted,
			}),
		);
	} catch {
		// ignore
	}
};

const dispatchSharedMediaPreferencesUpdated = (): void => {
	if (typeof window === 'undefined') {
		return;
	}

	window.dispatchEvent(new Event(SHARED_MEDIA_PREFERENCES_UPDATED_EVENT));
};

const getSnapshot = (): TSharedMediaPreferences => {
	if (sharedMediaPreferencesCache !== null) {
		return sharedMediaPreferencesCache;
	}

	sharedMediaPreferencesCache = loadSharedMediaPreferences();
	return sharedMediaPreferencesCache;
};

const getServerSnapshot = (): TSharedMediaPreferences => DEFAULT_SHARED_MEDIA_PREFERENCES;

const setSharedMediaPreferences = (preferences: TSharedMediaPreferences): void => {
	const nextPreferences = normalizePreferences(preferences);
	const currentPreferences = getSnapshot();

	if (currentPreferences.volume === nextPreferences.volume && currentPreferences.muted === nextPreferences.muted) {
		return;
	}

	sharedMediaPreferencesCache = nextPreferences;
	saveSharedMediaPreferences(nextPreferences);
	dispatchSharedMediaPreferencesUpdated();
};

const subscribe = (callback: () => void): (() => void) => {
	if (typeof window === 'undefined') {
		return () => undefined;
	}

	const handlePreferencesUpdated = () => {
		callback();
	};

	const handleStorage = (event: StorageEvent) => {
		if (event.key !== null && event.key !== SHARED_MEDIA_STORAGE_KEY) {
			return;
		}

		sharedMediaPreferencesCache = null;
		callback();
	};

	window.addEventListener(SHARED_MEDIA_PREFERENCES_UPDATED_EVENT, handlePreferencesUpdated);
	window.addEventListener('storage', handleStorage);

	return () => {
		window.removeEventListener(SHARED_MEDIA_PREFERENCES_UPDATED_EVENT, handlePreferencesUpdated);
		window.removeEventListener('storage', handleStorage);
	};
};

const useSharedMediaPreferences = (): TSharedMediaPreferences => {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
};

const useSyncSharedMediaPreferences = (playerRef: RefObject<MediaPlayerInstance | null>): TSharedMediaPreferences => {
	const preferences = useSharedMediaPreferences();

	useEffect(() => {
		const player = playerRef.current;

		if (!player) {
			return;
		}

		const handleVolumeChange = (event: Event) => {
			const detail = getEventPreferences(event);
			if (!detail) {
				return;
			}

			setSharedMediaPreferences(detail);
		};

		player.addEventListener('volume-change', handleVolumeChange);

		return () => {
			player.removeEventListener('volume-change', handleVolumeChange);
		};
	}, [playerRef]);

	return preferences;
};

export { useSyncSharedMediaPreferences };
