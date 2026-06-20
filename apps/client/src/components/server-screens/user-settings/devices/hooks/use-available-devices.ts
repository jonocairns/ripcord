import { useCallback, useEffect, useState } from 'react';

// Drivers that expose virtual microphones (e.g. NVIDIA Broadcast / RTX Voice)
// often start after the app has already enumerated devices on a cold boot. We
// debounce the burst of `devicechange` events the OS emits while the driver
// settles, then re-enumerate so the device list stays current while open.
const DEVICE_CHANGE_DEBOUNCE_MS = 300;

const useAvailableDevices = () => {
	const [inputDevices, setInputDevices] = useState<(MediaDeviceInfo | undefined)[]>([]);
	const [playbackDevices, setPlaybackDevices] = useState<(MediaDeviceInfo | undefined)[]>([]);
	const [videoDevices, setVideoDevices] = useState<(MediaDeviceInfo | undefined)[]>([]);
	const [loading, setLoading] = useState(true);

	const loadDevices = useCallback(async () => {
		const devices = await navigator.mediaDevices.enumerateDevices();

		const inputDevices = devices.filter((device) => device.kind === 'audioinput');

		const playbackDevices = devices.filter((device) => device.kind === 'audiooutput');

		const videoDevices = devices.filter((device) => device.kind === 'videoinput');

		setInputDevices(inputDevices);
		setPlaybackDevices(playbackDevices);
		setVideoDevices(videoDevices);

		setLoading(false);
	}, []);

	useEffect(() => {
		loadDevices();

		const mediaDevices = navigator.mediaDevices;

		if (!mediaDevices?.addEventListener) {
			return;
		}

		let debounceTimer: ReturnType<typeof setTimeout> | undefined;

		const handleDeviceChange = () => {
			if (debounceTimer !== undefined) {
				clearTimeout(debounceTimer);
			}

			debounceTimer = setTimeout(() => {
				debounceTimer = undefined;
				loadDevices();
			}, DEVICE_CHANGE_DEBOUNCE_MS);
		};

		mediaDevices.addEventListener('devicechange', handleDeviceChange);

		return () => {
			if (debounceTimer !== undefined) {
				clearTimeout(debounceTimer);
			}

			mediaDevices.removeEventListener('devicechange', handleDeviceChange);
		};
	}, [loadDevices]);

	return { inputDevices, playbackDevices, videoDevices, loading };
};

export { useAvailableDevices };
