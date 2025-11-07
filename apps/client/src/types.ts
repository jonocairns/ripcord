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
  '240p' = '240p'
}

export enum LocalStorageKey {
  IDENTITY = 'sharkord-identity',
  REMEMBER_CREDENTIALS = 'sharkord-remember-identity',
  USER_PASSWORD = 'sharkord-user-password',
  SERVER_PASSWORD = 'sharkord-server-password'
}

export enum SessionStorageKey {
  TOKEN = 'sharkord-token'
}

export enum ChannelType {
  TEXT = 'TEXT',
  VOICE = 'VOICE'
}

export enum StreamKind {
  AUDIO = 'audio',
  VIDEO = 'video',
  SCREEN = 'screen'
}
