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
  voiceFilterStrength: VoiceFilterStrength.BALANCED,
  screenAudioMode: ScreenAudioMode.SYSTEM,
  mirrorOwnVideo: false,
  screenResolution: Resolution['720p'],
  screenFramerate: 30,
  videoCodec: VideoCodecPreference.AUTO
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

  return {
    ...DEFAULT_DEVICE_SETTINGS,
    ...incomingSettings,
    micQualityMode: [MicQualityMode.AUTO, MicQualityMode.EXPERIMENTAL].includes(
      incomingSettings.micQualityMode as MicQualityMode
    )
      ? (incomingSettings.micQualityMode as MicQualityMode)
      : MicQualityMode.AUTO,   // MANUAL and unknown → Standard
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
    voiceFilterStrength: Object.values(VoiceFilterStrength).includes(
      incomingSettings.voiceFilterStrength as VoiceFilterStrength
    )
      ? (incomingSettings.voiceFilterStrength as VoiceFilterStrength)
      : DEFAULT_DEVICE_SETTINGS.voiceFilterStrength,
    pushToTalkKeybind,
    pushToMuteKeybind:
      pushToMuteKeybind && pushToMuteKeybind === pushToTalkKeybind
        ? undefined
        : pushToMuteKeybind
  };
};

export { DEFAULT_DEVICE_SETTINGS, migrateDeviceSettings };
