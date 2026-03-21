const DEFAULT_MEDIA_DEVICE_ID = 'default';

type TSelectableMediaDeviceOption = {
	value: string;
	label: string;
};

const getExactMediaDeviceId = (deviceId: string | undefined): string | undefined => {
	if (!deviceId || deviceId === DEFAULT_MEDIA_DEVICE_ID) {
		return undefined;
	}

	return deviceId;
};

const normalizeStoredMediaDeviceId = (
	deviceId: string | undefined,
	availableDevices: (MediaDeviceInfo | undefined)[],
): string | undefined => {
	const exactDeviceId = getExactMediaDeviceId(deviceId);

	if (!exactDeviceId) {
		return undefined;
	}

	return availableDevices.some((device) => device?.deviceId === exactDeviceId) ? exactDeviceId : undefined;
};

const getSelectedMediaDeviceId = (
	deviceId: string | undefined,
	availableDevices: (MediaDeviceInfo | undefined)[],
): string => {
	return normalizeStoredMediaDeviceId(deviceId, availableDevices) ?? DEFAULT_MEDIA_DEVICE_ID;
};

const getSelectableMediaDeviceOptions = (
	availableDevices: (MediaDeviceInfo | undefined)[],
	defaultLabel: string,
): TSelectableMediaDeviceOption[] => {
	const optionsById = new Map<string, string>();

	for (const device of availableDevices) {
		const exactDeviceId = getExactMediaDeviceId(device?.deviceId);

		if (!exactDeviceId || optionsById.has(exactDeviceId)) {
			continue;
		}

		optionsById.set(exactDeviceId, device?.label.trim() || defaultLabel);
	}

	return [
		{
			value: DEFAULT_MEDIA_DEVICE_ID,
			label: defaultLabel,
		},
		...Array.from(optionsById, ([value, label]) => ({
			value,
			label,
		})),
	];
};

export {
	DEFAULT_MEDIA_DEVICE_ID,
	getExactMediaDeviceId,
	getSelectableMediaDeviceOptions,
	getSelectedMediaDeviceId,
	normalizeStoredMediaDeviceId,
};
