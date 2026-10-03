import type { TDeviceSettings } from '@/types';

const resolveMicCaptureConfig = (devices: TDeviceSettings) => {
	const wasmNoiseSuppressionEnabled = devices.wasmNoiseSuppressionEnabled && devices.noiseSuppression;
	const constraints: MediaTrackConstraints = {
		...(devices.microphoneId
			? {
					deviceId: {
						exact: devices.microphoneId,
					},
				}
			: {}),
		autoGainControl: devices.autoGainControl,
		echoCancellation: devices.echoCancellation,
		noiseSuppression: wasmNoiseSuppressionEnabled ? false : devices.noiseSuppression,
		sampleRate: 48000,
	};

	return {
		constraints,
		processingEnabled: wasmNoiseSuppressionEnabled,
	};
};

const didMicCaptureSettingsChange = (previousDevices: TDeviceSettings, nextDevices: TDeviceSettings): boolean => {
	return (
		previousDevices.microphoneId !== nextDevices.microphoneId ||
		previousDevices.echoCancellation !== nextDevices.echoCancellation ||
		previousDevices.noiseSuppression !== nextDevices.noiseSuppression ||
		previousDevices.wasmNoiseSuppressionEnabled !== nextDevices.wasmNoiseSuppressionEnabled ||
		previousDevices.autoGainControl !== nextDevices.autoGainControl
	);
};

export { didMicCaptureSettingsChange, resolveMicCaptureConfig };
