import { ScreenAudioMode } from '@/runtime/types';
import {
  MicQualityMode,
  Resolution,
  type TDeviceSettings,
  VideoCodecPreference,
  VoiceFilterStrength
} from '@/types';
import { normalizePushKeybind } from './push-keybind';

type TLegacyDeviceSettings = Partial<TDeviceSettings> & {
  shareSystemAudio?: boolean;
};

const DEFAULT_SIDECAR_DFN_MIX = 0.9;

const DEFAULT_DEVICE_SETTINGS: TDeviceSettings = {
  microphoneId: undefined,
  micQualityMode: MicQualityMode.AUTO,
  pushToTalkKeybind: undefined,
  pushToMuteKeybind: undefined,
  webcamId: undefined,
  webcamResolution: Resolution['720p'],
  webcamFramerate: 30,
  echoCancellation: true,
  noiseSuppression: true,
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
  videoCodec: VideoCodecPreference.AUTO
};

const normalizeVoiceFilterStrength = (
  strength: unknown
): VoiceFilterStrength => {
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

const migrateDeviceSettings = (
  incomingSettings: TLegacyDeviceSettings | undefined
): TDeviceSettings => {
  if (!incomingSettings) {
    return DEFAULT_DEVICE_SETTINGS;
  }

  let screenAudioMode = incomingSettings.screenAudioMode;

  if (
    !screenAudioMode &&
    typeof incomingSettings.shareSystemAudio === 'boolean'
  ) {
    screenAudioMode = incomingSettings.shareSystemAudio
      ? ScreenAudioMode.SYSTEM
      : ScreenAudioMode.NONE;
  }

  const pushToTalkKeybind = normalizePushKeybind(
    incomingSettings.pushToTalkKeybind
  );
  const pushToMuteKeybind = normalizePushKeybind(
    incomingSettings.pushToMuteKeybind
  );
  const sidecarDfnMix =
    typeof incomingSettings.sidecarDfnMix === 'number' &&
    Number.isFinite(incomingSettings.sidecarDfnMix)
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

  return {
    ...DEFAULT_DEVICE_SETTINGS,
    ...incomingSettings,
    micQualityMode: [MicQualityMode.AUTO, MicQualityMode.EXPERIMENTAL].includes(
      incomingSettings.micQualityMode as MicQualityMode
    )
      ? (incomingSettings.micQualityMode as MicQualityMode)
      : MicQualityMode.AUTO, // MANUAL and unknown → Standard
    screenAudioMode: screenAudioMode || ScreenAudioMode.SYSTEM,
    videoCodec: Object.values(VideoCodecPreference).includes(
      incomingSettings.videoCodec as VideoCodecPreference
    )
      ? (incomingSettings.videoCodec as VideoCodecPreference)
      : VideoCodecPreference.AUTO,
    experimentalVoiceFilter:
      typeof incomingSettings.experimentalVoiceFilter === 'boolean'
        ? incomingSettings.experimentalVoiceFilter
        : DEFAULT_DEVICE_SETTINGS.experimentalVoiceFilter,
    voiceFilterStrength: normalizeVoiceFilterStrength(
      incomingSettings.voiceFilterStrength
    ),
    sidecarDfnMix,
    sidecarDfnAttenuationLimitDb,
    sidecarExperimentalAggressiveMode:
      typeof incomingSettings.sidecarExperimentalAggressiveMode === 'boolean'
        ? incomingSettings.sidecarExperimentalAggressiveMode
        : DEFAULT_DEVICE_SETTINGS.sidecarExperimentalAggressiveMode,
    sidecarNoiseGateFloorDbfs,
    pushToTalkKeybind,
    pushToMuteKeybind:
      pushToMuteKeybind && pushToMuteKeybind === pushToTalkKeybind
        ? undefined
        : pushToMuteKeybind
  };
};

export { DEFAULT_DEVICE_SETTINGS, migrateDeviceSettings };
