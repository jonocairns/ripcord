import type { StreamKind } from '@sharkord/shared';
import { ScreenAudioMode } from './runtime/types';

export type TDevices = {
  input: {
    deviceId: string | undefined;
    autoGainControl: boolean;
    echoCancellation: boolean;
    noiseSuppression: boolean;
  };
  playback: {
    deviceId: string | undefined;
  };
  webcam: {
    deviceId: string | undefined;
    resolution: Resolution;
    framerate: number;
  };
  screen: {
    resolution: Resolution;
    framerate: number;
    audio: boolean;
  };
};

export enum Resolution {
  '2160p' = '2160p',
  '1440p' = '1440p',
  '1080p' = '1080p',
  '720p' = '720p',
  '480p' = '480p',
  '360p' = '360p',
  '240p' = '240p',
  '144p' = '144p'
}

export enum VideoCodecPreference {
  AUTO = 'auto',
  VP8 = 'vp8',
  H264 = 'h264',
  AV1 = 'av1'
}

export enum VoiceFilterStrength {
  LOW = 'low',
  BALANCED = 'balanced',
  HIGH = 'high',
  AGGRESSIVE = 'aggressive'
}

export enum MicQualityMode {
  AUTO = 'auto',
  MANUAL = 'manual',       // kept for migration only
  EXPERIMENTAL = 'experimental'
}

export type TDeviceSettings = {
  microphoneId: string | undefined;
  micQualityMode: MicQualityMode;
  pushToTalkKeybind: string | undefined;
  pushToMuteKeybind: string | undefined;
  webcamId: string | undefined;
  webcamResolution: Resolution;
  webcamFramerate: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  experimentalVoiceFilter: boolean;
  voiceFilterStrength: VoiceFilterStrength;
  screenAudioMode: ScreenAudioMode;
  mirrorOwnVideo: boolean;
  screenResolution: Resolution;
  screenFramerate: number;
  videoCodec: VideoCodecPreference;
};

export type TRemoteUserStreamKinds =
  | StreamKind.AUDIO
  | StreamKind.VIDEO
  | StreamKind.SCREEN
  | StreamKind.SCREEN_AUDIO;

export type TRemoteStreams = {
  [userId: number]: {
    [StreamKind.AUDIO]: MediaStream | undefined;
    [StreamKind.VIDEO]: MediaStream | undefined;
    [StreamKind.SCREEN]: MediaStream | undefined;
    [StreamKind.SCREEN_AUDIO]: MediaStream | undefined;
  };
};
