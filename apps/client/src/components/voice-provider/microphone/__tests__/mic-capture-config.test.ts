import { describe, expect, it } from 'bun:test';
import { DEFAULT_DEVICE_SETTINGS } from '@/components/devices-provider/migrate-device-settings';
import { Resolution, type TDeviceSettings, VideoCodecPreference } from '@/types';
import { didMicCaptureSettingsChange, resolveMicCaptureConfig } from '../mic-capture-config';

describe('microphone capture configuration', () => {
	it('uses the browser default input without an exact device constraint', () => {
		expect(resolveMicCaptureConfig(DEFAULT_DEVICE_SETTINGS)).toEqual({
			constraints: { autoGainControl: true, echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
			processingEnabled: false,
		});
	});

	it('pins an explicitly selected input and preserves the browser processing settings', () => {
		const config = resolveMicCaptureConfig({
			...DEFAULT_DEVICE_SETTINGS,
			microphoneId: 'selected-input',
			autoGainControl: false,
			echoCancellation: false,
			noiseSuppression: false,
		});
		expect(config.constraints).toEqual({
			deviceId: { exact: 'selected-input' },
			autoGainControl: false,
			echoCancellation: false,
			noiseSuppression: false,
			sampleRate: 48000,
		});
	});

	it.each([
		{ noiseSuppression: false, wasmNoiseSuppressionEnabled: false, browserSuppression: false, processing: false },
		{ noiseSuppression: false, wasmNoiseSuppressionEnabled: true, browserSuppression: false, processing: false },
		{ noiseSuppression: true, wasmNoiseSuppressionEnabled: false, browserSuppression: true, processing: false },
		{ noiseSuppression: true, wasmNoiseSuppressionEnabled: true, browserSuppression: false, processing: true },
	])('chooses browser or WASM suppression for %j', ({
		noiseSuppression,
		wasmNoiseSuppressionEnabled,
		browserSuppression,
		processing,
	}) => {
		const config = resolveMicCaptureConfig({
			...DEFAULT_DEVICE_SETTINGS,
			noiseSuppression,
			wasmNoiseSuppressionEnabled,
		});
		expect(config.processingEnabled).toBe(processing);
		expect(config.constraints.noiseSuppression).toBe(browserSuppression);
		expect(config.constraints.echoCancellation).toBe(true);
		expect(config.constraints.autoGainControl).toBe(true);
	});
});

describe('microphone capture settings comparison', () => {
	const captureChanges: Partial<TDeviceSettings>[] = [
		{ microphoneId: 'another-input' },
		{ echoCancellation: false },
		{ noiseSuppression: false },
		{ wasmNoiseSuppressionEnabled: true },
		{ autoGainControl: false },
	];

	it.each(captureChanges)('requires a capture restart for %j', (change) => {
		expect(didMicCaptureSettingsChange(DEFAULT_DEVICE_SETTINGS, { ...DEFAULT_DEVICE_SETTINGS, ...change })).toBe(true);
	});

	it('still restarts for a WASM preference change while noise suppression is disabled', () => {
		const previous = { ...DEFAULT_DEVICE_SETTINGS, noiseSuppression: false };
		expect(didMicCaptureSettingsChange(previous, { ...previous, wasmNoiseSuppressionEnabled: true })).toBe(true);
	});

	it('keeps capture for unchanged settings and unrelated device, keybind, or input metadata changes', () => {
		expect(didMicCaptureSettingsChange(DEFAULT_DEVICE_SETTINGS, { ...DEFAULT_DEVICE_SETTINGS })).toBe(false);
		expect(
			didMicCaptureSettingsChange(DEFAULT_DEVICE_SETTINGS, {
				...DEFAULT_DEVICE_SETTINGS,
				microphoneGroupId: 'new-default-group',
				microphoneLabel: 'new-default-label',
				pushToTalkKeybind: 'KeyT',
				pushReleaseDelayMs: 100,
				webcamId: 'another-camera',
				webcamResolution: Resolution['1080p'],
				videoCodec: VideoCodecPreference.VP9,
			}),
		).toBe(false);
	});
});
