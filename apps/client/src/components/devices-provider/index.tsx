import { createContext, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { getLocalStorageItemAsJSON, LocalStorageKey, setLocalStorageItemAsJSON } from '@/helpers/storage';
import { useAvailableDevices } from '@/hooks/use-available-devices';
import type { TDeviceSettings } from '@/types';
import { normalizeStoredMediaDeviceId } from './media-device-selection';
import { DEFAULT_DEVICE_SETTINGS, migrateDeviceSettings } from './migrate-device-settings';

export type TDevicesProvider = {
	loading: boolean;
	devices: TDeviceSettings;
	saveDevices: (newDevices: TDeviceSettings) => void;
};

const DevicesProviderContext = createContext<TDevicesProvider>({
	loading: false,
	devices: DEFAULT_DEVICE_SETTINGS,
	saveDevices: () => {},
});

type TDevicesProviderProps = {
	children: React.ReactNode;
};

const DevicesProvider = memo(({ children }: TDevicesProviderProps) => {
	const [loading, setLoading] = useState<boolean>(true);
	const [devices, setDevices] = useState<TDeviceSettings>(DEFAULT_DEVICE_SETTINGS);
	const { inputDevices, videoDevices, loading: devicesLoading } = useAvailableDevices();

	const saveDevices = useCallback((newDevices: TDeviceSettings) => {
		setDevices(newDevices);
		setLocalStorageItemAsJSON<TDeviceSettings>(LocalStorageKey.DEVICES_SETTINGS, newDevices);
	}, []);

	useEffect(() => {
		if (devicesLoading) return;

		const savedSettings = getLocalStorageItemAsJSON<TDeviceSettings>(LocalStorageKey.DEVICES_SETTINGS);
		const normalizedSettings = migrateDeviceSettings(savedSettings);

		setDevices({
			...normalizedSettings,
			microphoneId: normalizeStoredMediaDeviceId(normalizedSettings.microphoneId, inputDevices, {
				groupId: normalizedSettings.microphoneGroupId,
				label: normalizedSettings.microphoneLabel,
			}),
			webcamId: normalizeStoredMediaDeviceId(normalizedSettings.webcamId, videoDevices, {
				groupId: normalizedSettings.webcamGroupId,
				label: normalizedSettings.webcamLabel,
			}),
		});

		setLoading(false);
	}, [devicesLoading, inputDevices, videoDevices]);

	const contextValue = useMemo<TDevicesProvider>(
		() => ({
			loading,
			devices,
			saveDevices,
		}),
		[loading, devices, saveDevices],
	);

	return <DevicesProviderContext.Provider value={contextValue}>{children}</DevicesProviderContext.Provider>;
});

export { DevicesProvider, DevicesProviderContext };
