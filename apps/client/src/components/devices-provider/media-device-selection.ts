const DEFAULT_MEDIA_DEVICE_ID = 'default';

type TSelectableMediaDeviceOption = {
	value: string;
	label: string;
};

type TStoredMediaDeviceMetadata = {
	groupId: string | undefined;
	label: string | undefined;
};

const normalizeMediaDeviceLabel = (label: string | undefined): string | undefined => {
	const normalizedLabel = label?.trim();
	return normalizedLabel ? normalizedLabel : undefined;
};

const getExactMediaDeviceId = (deviceId: string | undefined): string | undefined => {
	if (!deviceId || deviceId === DEFAULT_MEDIA_DEVICE_ID) {
		return undefined;
	}

	return deviceId;
};

const getStoredMediaDeviceMetadata = (
	deviceId: string | undefined,
	availableDevices: (MediaDeviceInfo | undefined)[],
): TStoredMediaDeviceMetadata => {
	const exactDeviceId = getExactMediaDeviceId(deviceId);

	if (!exactDeviceId) {
		return {
			groupId: undefined,
			label: undefined,
		};
	}

	const matchedDevice = availableDevices.find((device) => device?.deviceId === exactDeviceId);

	return {
		groupId: matchedDevice?.groupId || undefined,
		label: normalizeMediaDeviceLabel(matchedDevice?.label),
	};
};

const getNormalizedAvailableDeviceMetadata = (
	deviceId: string | undefined,
	availableDevices: (MediaDeviceInfo | undefined)[],
) => {
	return getStoredMediaDeviceMetadata(deviceId, availableDevices);
};

const findMatchingAvailableDevice = (
	deviceId: string | undefined,
	availableDevices: (MediaDeviceInfo | undefined)[],
	metadata?: TStoredMediaDeviceMetadata,
): MediaDeviceInfo | undefined => {
	const exactDeviceId = getExactMediaDeviceId(deviceId);

	if (!exactDeviceId) {
		return undefined;
	}

	const exactMatch = availableDevices.find((device) => device?.deviceId === exactDeviceId);

	if (exactMatch) {
		return exactMatch;
	}

	if (metadata?.groupId) {
		const groupMatches = availableDevices.filter((device) => {
			return device?.groupId === metadata.groupId && getExactMediaDeviceId(device?.deviceId) !== undefined;
		});

		if (groupMatches.length === 1) {
			return groupMatches[0];
		}
	}

	const normalizedLabel = normalizeMediaDeviceLabel(metadata?.label);

	if (!normalizedLabel) {
		return undefined;
	}

	const labelMatches = availableDevices.filter(
		(device) => normalizeMediaDeviceLabel(device?.label) === normalizedLabel,
	);

	return labelMatches.length === 1 ? labelMatches[0] : undefined;
};

const normalizeStoredMediaDeviceId = (
	deviceId: string | undefined,
	availableDevices: (MediaDeviceInfo | undefined)[],
	metadata?: TStoredMediaDeviceMetadata,
): string | undefined => {
	return findMatchingAvailableDevice(deviceId, availableDevices, metadata)?.deviceId;
};

const getSelectedMediaDeviceId = (
	deviceId: string | undefined,
	availableDevices: (MediaDeviceInfo | undefined)[],
	metadata?: TStoredMediaDeviceMetadata,
): string => {
	return normalizeStoredMediaDeviceId(deviceId, availableDevices, metadata) ?? DEFAULT_MEDIA_DEVICE_ID;
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
	getNormalizedAvailableDeviceMetadata,
	getSelectableMediaDeviceOptions,
	getSelectedMediaDeviceId,
	getStoredMediaDeviceMetadata,
	normalizeStoredMediaDeviceId,
};
