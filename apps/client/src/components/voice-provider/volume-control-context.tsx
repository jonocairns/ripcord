import { createContext, useContext } from 'react';
import type { TVolumeKey, TVolumeSettings } from './volume-control-storage';

type TVolumeControlContext = {
  volumes: TVolumeSettings;
  getVolume: (key: TVolumeKey) => number;
  setVolume: (key: TVolumeKey, volume: number) => void;
  toggleMute: (key: TVolumeKey) => void;
  getUserVolumeKey: (userId: number) => TVolumeKey;
  getUserScreenVolumeKey: (userId: number) => TVolumeKey;
  getExternalVolumeKey: (pluginId: string, key: string) => TVolumeKey;
};

const VolumeControlContext = createContext<TVolumeControlContext | null>(null);

const useVolumeControl = () => {
  const context = useContext(VolumeControlContext);

  if (!context) {
    throw new Error(
      'useVolumeControl must be used within VolumeControlProvider'
    );
  }

  return context;
};

export { useVolumeControl, VolumeControlContext };
export type { TVolumeControlContext };
