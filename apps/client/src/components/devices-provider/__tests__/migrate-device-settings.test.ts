import { describe, expect, it } from 'bun:test';
import { ScreenAudioMode } from '@/runtime/types';
import { MicQualityMode, VideoCodecPreference, VoiceFilterStrength } from '@/types';
import { DEFAULT_DEVICE_SETTINGS, migrateDeviceSettings } from '../migrate-device-settings';

describe('migrateDeviceSettings', () => {
	it('returns defaults when no saved data exists', () => {
		expect(migrateDeviceSettings(undefined)).toEqual(DEFAULT_DEVICE_SETTINGS);
		expect(DEFAULT_DEVICE_SETTINGS.experimentalVoiceFilter).toBe(false);
		expect(DEFAULT_DEVICE_SETTINGS.micQualityMode).toBe(MicQualityMode.AUTO);
		expect(DEFAULT_DEVICE_SETTINGS.pushToTalkKeybind).toBeUndefined();
		expect(DEFAULT_DEVICE_SETTINGS.pushToMuteKeybind).toBeUndefined();
		expect(DEFAULT_DEVICE_SETTINGS.echoCancellation).toBe(true);
		expect(DEFAULT_DEVICE_SETTINGS.noiseSuppression).toBe(true);
		expect(DEFAULT_DEVICE_SETTINGS.wasmNoiseSuppressionEnabled).toBe(false);
		expect(DEFAULT_DEVICE_SETTINGS.voiceFilterStrength).toBe(VoiceFilterStrength.HIGH);
	});

	it('defaults legacy settings to auto mic quality mode', () => {
		const migrated = migrateDeviceSettings({
			microphoneId: 'legacy-device',
		});

		expect(migrated.micQualityMode).toBe(MicQualityMode.AUTO);
	});

	it('keeps explicit auto mic quality mode as auto', () => {
		const migrated = migrateDeviceSettings({
			micQualityMode: MicQualityMode.AUTO,
		});

		expect(migrated.micQualityMode).toBe(MicQualityMode.AUTO);
	});

	it('normalizes experimental mic quality mode to auto', () => {
		const migrated = migrateDeviceSettings({
			micQualityMode: MicQualityMode.EXPERIMENTAL,
		});

		expect(migrated.micQualityMode).toBe(MicQualityMode.AUTO);
	});

	it('migrates legacy shareSystemAudio=true to system mode', () => {
		const migrated = migrateDeviceSettings({
			shareSystemAudio: true,
		});

		expect(migrated.screenAudioMode).toBe(ScreenAudioMode.SYSTEM);
	});

	it('migrates legacy shareSystemAudio=false to none mode', () => {
		const migrated = migrateDeviceSettings({
			shareSystemAudio: false,
		});

		expect(migrated.screenAudioMode).toBe(ScreenAudioMode.NONE);
	});

	it('preserves explicit screenAudioMode values', () => {
		const migrated = migrateDeviceSettings({
			screenAudioMode: ScreenAudioMode.APP,
			shareSystemAudio: false,
		});

		expect(migrated.screenAudioMode).toBe(ScreenAudioMode.APP);
	});

	it('preserves explicit experimentalVoiceFilter values', () => {
		const migrated = migrateDeviceSettings({
			experimentalVoiceFilter: true,
		});

		expect(migrated.experimentalVoiceFilter).toBe(true);
	});

	it('preserves explicit wasmNoiseSuppressionEnabled values', () => {
		const migrated = migrateDeviceSettings({
			wasmNoiseSuppressionEnabled: true,
		});

		expect(migrated.wasmNoiseSuppressionEnabled).toBe(true);
	});

	it('preserves explicit voiceFilterStrength values', () => {
		const migrated = migrateDeviceSettings({
			voiceFilterStrength: VoiceFilterStrength.AGGRESSIVE,
		});

		expect(migrated.voiceFilterStrength).toBe(VoiceFilterStrength.AGGRESSIVE);
	});

	it('coerces legacy low and balanced voiceFilterStrength values to high', () => {
		expect(
			migrateDeviceSettings({
				voiceFilterStrength: VoiceFilterStrength.LOW,
			}).voiceFilterStrength,
		).toBe(VoiceFilterStrength.HIGH);

		expect(
			migrateDeviceSettings({
				voiceFilterStrength: VoiceFilterStrength.BALANCED,
			}).voiceFilterStrength,
		).toBe(VoiceFilterStrength.HIGH);
	});

	it('falls back to high for invalid voiceFilterStrength values', () => {
		const migrated = migrateDeviceSettings({
			voiceFilterStrength: 'invalid' as VoiceFilterStrength,
		});

		expect(migrated.voiceFilterStrength).toBe(VoiceFilterStrength.HIGH);
	});

	it('defaults video codec to auto for legacy settings', () => {
		const migrated = migrateDeviceSettings({});
		expect(migrated.videoCodec).toBe(VideoCodecPreference.AUTO);
	});

	it('preserves explicit video codec values', () => {
		const migrated = migrateDeviceSettings({
			videoCodec: VideoCodecPreference.AV1,
		});
		expect(migrated.videoCodec).toBe(VideoCodecPreference.AV1);
	});

	it('normalizes push keybinds from legacy aliases', () => {
		const migrated = migrateDeviceSettings({
			pushToTalkKeybind: 'Ctrl+Shift+KeyV',
		});

		expect(migrated.pushToTalkKeybind).toBe('Control+Shift+KeyV');
	});

	it('drops invalid push keybind values', () => {
		const migrated = migrateDeviceSettings({
			pushToTalkKeybind: 'Control+Alt+Shift',
		});

		expect(migrated.pushToTalkKeybind).toBeUndefined();
	});

	it('drops duplicate push-to-mute keybinds', () => {
		const migrated = migrateDeviceSettings({
			pushToTalkKeybind: 'Control+KeyV',
			pushToMuteKeybind: 'Control+KeyV',
		});

		expect(migrated.pushToTalkKeybind).toBe('Control+KeyV');
		expect(migrated.pushToMuteKeybind).toBeUndefined();
	});
});
