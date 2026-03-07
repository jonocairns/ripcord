import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';

type TVolumeKey = string;

type TVolumeSettings = Record<TVolumeKey, number>;

type TVolumeSettingsUpdatedDetail = {
  key: TVolumeKey;
  volume: number;
};

const MASTER_OUTPUT_VOLUME_KEY = 'master-output';
const OWN_MIC_VOLUME_KEY = 'own-mic';
const VOLUME_SETTINGS_UPDATED_EVENT = 'sharkord:volume-settings-updated';

const loadVolumesFromStorage = (): TVolumeSettings => {
  try {
    return (
      getLocalStorageItemAsJSON<TVolumeSettings>(
        LocalStorageKey.VOLUME_SETTINGS
      ) ?? {}
    );
  } catch {
    return {};
  }
};

const saveVolumesToStorage = (volumes: TVolumeSettings) => {
  try {
    setLocalStorageItemAsJSON(LocalStorageKey.VOLUME_SETTINGS, volumes);
  } catch {
    // ignore
  }
};

const dispatchVolumeSettingsUpdated = (
  detail: TVolumeSettingsUpdatedDetail
) => {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<TVolumeSettingsUpdatedDetail>(
      VOLUME_SETTINGS_UPDATED_EVENT,
      { detail }
    )
  );
};

const getStoredVolume = (key: TVolumeKey): number => {
  return loadVolumesFromStorage()[key] ?? 100;
};

export {
  dispatchVolumeSettingsUpdated,
  getStoredVolume,
  loadVolumesFromStorage,
  MASTER_OUTPUT_VOLUME_KEY,
  OWN_MIC_VOLUME_KEY,
  saveVolumesToStorage,
  VOLUME_SETTINGS_UPDATED_EVENT
};
export type { TVolumeKey, TVolumeSettings, TVolumeSettingsUpdatedDetail };
