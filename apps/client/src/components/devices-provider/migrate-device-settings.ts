import { clampFramerateToResolution } from '@/helpers/resolution-fps-policy';
import { ScreenAudioMode } from '@/runtime/types';
import { MicQualityMode, Resolution, type TDeviceSettings, VideoCodecPreference, VoiceFilterStrength } from '@/types';
import { normalizePushKeybind } from './push-keybind';

type TLegacyDeviceSettings = Partial<TDeviceSettings> & {
	shareSystemAudio?: boolean;
};

const DEFAULT_SIDECAR_DFN_MIX = 0.9;
const PUSH_RELEASE_DELAY_MAX_MS = 2_000;

const DEFAULT_DEVICE_SETTINGS: TDeviceSettings = {
	microphoneId: undefined,
	microphoneGroupId: undefined,
	microphoneLabel: undefined,
	micQualityMode: MicQualityMode.AUTO,
	pushToTalkKeybind: undefined,
	pushToMuteKeybind: undefined,
	pushReleaseDelayMs: 20,
	webcamId: undefined,
	webcamGroupId: undefined,
	webcamLabel: undefined,
	webcamResolution: Resolution['720p'],
	webcamFramerate: 30,
	echoCancellation: true,
	noiseSuppression: true,
	wasmNoiseSuppressionEnabled: false,
	autoGainControl: true,
	experimentalVoiceFilter: false,
	voiceFilterStrength: VoiceFilterStrength.HIGH,
	sidecarDfnMix: DEFAULT_SIDECAR_DFN_MIX,
	sidecarDfnAttenuationLimitDb: undefined,
	sidecarExperimentalAggressiveMode: false,
	sidecarNoiseGateFloorDbfs: undefined,
	screenAudioMode: ScreenAudioMode.SYSTEM,
	mirrorOwnVideo: false,
	screenResolution: Resolution['720p'],
	screenFramerate: 30,
	videoCodec: VideoCodecPreference.AUTO,
};

const normalizeVoiceFilterStrength = (strength: unknown): VoiceFilterStrength => {
	switch (strength) {
		case VoiceFilterStrength.AGGRESSIVE:
			return VoiceFilterStrength.AGGRESSIVE;
		case VoiceFilterStrength.LOW:
		case VoiceFilterStrength.BALANCED:
		case VoiceFilterStrength.HIGH:
			return VoiceFilterStrength.HIGH;
		default:
			return DEFAULT_DEVICE_SETTINGS.voiceFilterStrength;
	}
};

const migrateDeviceSettings = (incomingSettings: TLegacyDeviceSettings | undefined): TDeviceSettings => {
	if (!incomingSettings) {
		return DEFAULT_DEVICE_SETTINGS;
	}

	let screenAudioMode = incomingSettings.screenAudioMode;

	if (!screenAudioMode && typeof incomingSettings.shareSystemAudio === 'boolean') {
		screenAudioMode = incomingSettings.shareSystemAudio ? ScreenAudioMode.SYSTEM : ScreenAudioMode.NONE;
	}

	const pushToTalkKeybind = normalizePushKeybind(incomingSettings.pushToTalkKeybind);
	const pushToMuteKeybind = normalizePushKeybind(incomingSettings.pushToMuteKeybind);
	const pushReleaseDelayMs =
		typeof incomingSettings.pushReleaseDelayMs === 'number' && Number.isFinite(incomingSettings.pushReleaseDelayMs)
			? Math.min(PUSH_RELEASE_DELAY_MAX_MS, Math.max(0, Math.round(incomingSettings.pushReleaseDelayMs)))
			: DEFAULT_DEVICE_SETTINGS.pushReleaseDelayMs;
	const sidecarDfnMix =
		typeof incomingSettings.sidecarDfnMix === 'number' && Number.isFinite(incomingSettings.sidecarDfnMix)
			? Math.min(1, Math.max(0, incomingSettings.sidecarDfnMix))
			: DEFAULT_DEVICE_SETTINGS.sidecarDfnMix;
	const sidecarDfnAttenuationLimitDb =
		typeof incomingSettings.sidecarDfnAttenuationLimitDb === 'number' &&
		Number.isFinite(incomingSettings.sidecarDfnAttenuationLimitDb)
			? Math.min(60, Math.max(0, incomingSettings.sidecarDfnAttenuationLimitDb))
			: undefined;
	const sidecarNoiseGateFloorDbfs =
		typeof incomingSettings.sidecarNoiseGateFloorDbfs === 'number' &&
		Number.isFinite(incomingSettings.sidecarNoiseGateFloorDbfs)
			? Math.min(-36, Math.max(-80, incomingSettings.sidecarNoiseGateFloorDbfs))
			: undefined;

	// Clamp persisted framerates against their resolution so legacy out-of-range
	// combinations (e.g. an old 4K@120fps) are sanitized on load.
	const webcamResolution = incomingSettings.webcamResolution ?? DEFAULT_DEVICE_SETTINGS.webcamResolution;
	const screenResolution = incomingSettings.screenResolution ?? DEFAULT_DEVICE_SETTINGS.screenResolution;
	const webcamFramerate = clampFramerateToResolution(
		webcamResolution,
		incomingSettings.webcamFramerate ?? DEFAULT_DEVICE_SETTINGS.webcamFramerate,
	);
	const screenFramerate = clampFramerateToResolution(
		screenResolution,
		incomingSettings.screenFramerate ?? DEFAULT_DEVICE_SETTINGS.screenFramerate,
	);

	return {
		...DEFAULT_DEVICE_SETTINGS,
		...incomingSettings,
		webcamResolution,
		webcamFramerate,
		screenResolution,
		screenFramerate,
		micQualityMode: MicQualityMode.AUTO,
		screenAudioMode: screenAudioMode || ScreenAudioMode.SYSTEM,
		videoCodec: Object.values(VideoCodecPreference).includes(incomingSettings.videoCodec as VideoCodecPreference)
			? (incomingSettings.videoCodec as VideoCodecPreference)
			: VideoCodecPreference.AUTO,
		experimentalVoiceFilter:
			typeof incomingSettings.experimentalVoiceFilter === 'boolean'
				? incomingSettings.experimentalVoiceFilter
				: DEFAULT_DEVICE_SETTINGS.experimentalVoiceFilter,
		wasmNoiseSuppressionEnabled:
			typeof incomingSettings.wasmNoiseSuppressionEnabled === 'boolean'
				? incomingSettings.wasmNoiseSuppressionEnabled
				: DEFAULT_DEVICE_SETTINGS.wasmNoiseSuppressionEnabled,
		voiceFilterStrength: normalizeVoiceFilterStrength(incomingSettings.voiceFilterStrength),
		sidecarDfnMix,
		sidecarDfnAttenuationLimitDb,
		sidecarExperimentalAggressiveMode:
			typeof incomingSettings.sidecarExperimentalAggressiveMode === 'boolean'
				? incomingSettings.sidecarExperimentalAggressiveMode
				: DEFAULT_DEVICE_SETTINGS.sidecarExperimentalAggressiveMode,
		sidecarNoiseGateFloorDbfs,
		pushToTalkKeybind,
		pushToMuteKeybind: pushToMuteKeybind && pushToMuteKeybind === pushToTalkKeybind ? undefined : pushToMuteKeybind,
		pushReleaseDelayMs,
	};
};

export { DEFAULT_DEVICE_SETTINGS, migrateDeviceSettings };
