import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { VolumeControlContext } from './volume-control-context';
import {
	dispatchVolumeSettingsUpdated,
	loadVolumesFromStorage,
	saveVolumesToStorage,
	type TVolumeKey,
	type TVolumeSettings,
} from './volume-control-storage';

type TVolumeControlProviderProps = {
	children: ReactNode;
};

const VolumeControlProvider = memo(({ children }: TVolumeControlProviderProps) => {
	const [volumes, setVolumes] = useState<TVolumeSettings>(loadVolumesFromStorage);
	const volumesRef = useRef(volumes);
	const previousVolumesRef = useRef<TVolumeSettings>({});

	useEffect(() => {
		volumesRef.current = volumes;
	}, [volumes]);

	const getVolume = useCallback(
		(key: TVolumeKey): number => {
			return volumes[key] ?? 100;
		},
		[volumes],
	);

	const commitVolumes = useCallback((nextVolumes: TVolumeSettings) => {
		volumesRef.current = nextVolumes;
		setVolumes(nextVolumes);
		saveVolumesToStorage(nextVolumes);
	}, []);

	const setVolume = useCallback(
		(key: TVolumeKey, volume: number) => {
			const nextVolumes = { ...volumesRef.current, [key]: volume };

			commitVolumes(nextVolumes);
			dispatchVolumeSettingsUpdated({ key, volume });

			if (volume > 0) {
				previousVolumesRef.current[key] = volume;
			}
		},
		[commitVolumes],
	);

	const toggleMute = useCallback(
		(key: TVolumeKey) => {
			const currentVolume = volumesRef.current[key] ?? 100;
			const isMuted = currentVolume === 0;
			const newVolume = isMuted ? (previousVolumesRef.current[key] ?? 100) : 0;

			if (!isMuted) {
				previousVolumesRef.current[key] = currentVolume;
			}

			const nextVolumes = { ...volumesRef.current, [key]: newVolume };

			commitVolumes(nextVolumes);
			dispatchVolumeSettingsUpdated({ key, volume: newVolume });
		},
		[commitVolumes],
	);

	const getUserVolumeKey = useCallback((userId: number): TVolumeKey => {
		return `user-${userId}`;
	}, []);

	const getUserScreenVolumeKey = useCallback((userId: number): TVolumeKey => {
		return `userscreen-${userId}`;
	}, []);

	const getExternalVolumeKey = useCallback((pluginId: string, key: string): TVolumeKey => {
		return `external-${pluginId}-${key}`;
	}, []);

	return (
		<VolumeControlContext.Provider
			value={{
				volumes,
				getVolume,
				setVolume,
				toggleMute,
				getUserVolumeKey,
				getUserScreenVolumeKey,
				getExternalVolumeKey,
			}}
		>
			{children}
		</VolumeControlContext.Provider>
	);
});

export { VolumeControlProvider };
