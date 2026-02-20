export type TDesktopPlatform = 'windows' | 'macos' | 'linux';

export type TSupportLevel = 'supported' | 'best-effort' | 'unsupported';

export enum ScreenAudioMode {
  SYSTEM = 'system',
  APP = 'app',
  NONE = 'none'
}

export type TDesktopCapabilities = {
  platform: TDesktopPlatform;
  systemAudio: TSupportLevel;
  perAppAudio: TSupportLevel;
  sidecarAvailable?: boolean;
  notes: string[];
};

export type TDesktopShareSourceKind = 'screen' | 'window';

export type TDesktopShareSource = {
  id: string;
  name: string;
  kind: TDesktopShareSourceKind;
  thumbnailDataUrl: string;
  appIconDataUrl?: string;
};

export type TDesktopScreenShareSelection = {
  sourceId: string;
  audioMode: ScreenAudioMode;
  appAudioTargetId?: string;
};

export type TResolvedScreenAudioMode = {
  requestedMode: ScreenAudioMode;
  effectiveMode: ScreenAudioMode;
  warning?: string;
};

export type TDesktopAppAudioTarget = {
  id: string;
  label: string;
  pid: number;
  processName: string;
};

export type TDesktopAppAudioTargetsResult = {
  targets: TDesktopAppAudioTarget[];
  suggestedTargetId?: string;
  warning?: string;
};

export type TStartAppAudioCaptureInput = {
  sourceId: string;
  appAudioTargetId?: string;
};

export type TAppAudioSession = {
  sessionId: string;
  targetId: string;
  sampleRate: number;
  channels: number;
  framesPerBuffer: number;
  protocolVersion?: number;
  encoding?: 'f32le_base64';
};

export type TAppAudioFrame = {
  sessionId: string;
  targetId: string;
  sequence: number;
  sampleRate: number;
  channels: number;
  frameCount: number;
  pcmBase64: string;
  protocolVersion: number;
  encoding: 'f32le_base64';
  droppedFrameCount?: number;
};

export type TAppAudioPcmFrame = {
  sessionId: string;
  targetId: string;
  sequence: number;
  sampleRate: number;
  channels: number;
  frameCount: number;
  pcm: Float32Array;
  protocolVersion: number;
  droppedFrameCount?: number;
};

export type TAppAudioEndReason =
  | 'capture_stopped'
  | 'app_exited'
  | 'capture_error'
  | 'device_lost'
  | 'sidecar_exited';

export type TAppAudioStatusEvent = {
  sessionId: string;
  targetId: string;
  reason: TAppAudioEndReason;
  error?: string;
  protocolVersion?: number;
};

export type TVoiceFilterStrength =
  | 'low'
  | 'balanced'
  | 'high'
  | 'aggressive';

export type TVoiceFilterSession = {
  sessionId: string;
  sampleRate: number;
  channels: number;
  framesPerBuffer: number;
  protocolVersion?: number;
  encoding?: 'f32le_base64';
};

export type TVoiceFilterFrame = {
  sessionId: string;
  sequence: number;
  sampleRate: number;
  channels: number;
  frameCount: number;
  pcmBase64: string;
  protocolVersion: number;
  encoding: 'f32le_base64';
  droppedFrameCount?: number;
};

export type TVoiceFilterPcmFrame = {
  sessionId: string;
  sequence: number;
  sampleRate: number;
  channels: number;
  frameCount: number;
  pcm: Float32Array;
  protocolVersion: number;
};

export type TVoiceFilterStatusEvent = {
  sessionId: string;
  reason: 'capture_stopped' | 'capture_error' | 'sidecar_exited';
  error?: string;
  protocolVersion?: number;
};

export type TDesktopUpdateState =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export type TDesktopUpdateStatus = {
  state: TDesktopUpdateState;
  currentVersion: string;
  availableVersion?: string;
  checkedAtIso?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferredBytes?: number;
  totalBytes?: number;
  message?: string;
};

export type TStartVoiceFilterInput = {
  sampleRate: number;
  channels: number;
  suppressionLevel: TVoiceFilterStrength;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  echoCancellation: boolean;
};

export type TPushKeybindKind = 'talk' | 'mute';

export type TDesktopPushKeybindsInput = {
  pushToTalkKeybind?: string;
  pushToMuteKeybind?: string;
};

export type TDesktopPushKeybindEvent = {
  kind: TPushKeybindKind;
  active: boolean;
};

export type TGlobalPushKeybindRegistrationResult = {
  talkRegistered: boolean;
  muteRegistered: boolean;
  errors: string[];
};

export type TDesktopBridge = {
  getServerUrl: () => Promise<string>;
  setServerUrl: (serverUrl: string) => Promise<void>;
  getCapabilities: () => Promise<TDesktopCapabilities>;
  pingSidecar: () => Promise<{ available: boolean; reason?: string }>;
  getUpdateStatus: () => Promise<TDesktopUpdateStatus>;
  checkForUpdates: () => Promise<TDesktopUpdateStatus>;
  installUpdateAndRestart: () => Promise<boolean>;
  listShareSources: () => Promise<TDesktopShareSource[]>;
  listAppAudioTargets: (
    sourceId?: string
  ) => Promise<TDesktopAppAudioTargetsResult>;
  startAppAudioCapture: (
    input: TStartAppAudioCaptureInput
  ) => Promise<TAppAudioSession>;
  stopAppAudioCapture: (sessionId?: string) => Promise<void>;
  startVoiceFilterSession: (
    input: TStartVoiceFilterInput
  ) => Promise<TVoiceFilterSession>;
  stopVoiceFilterSession: (sessionId?: string) => Promise<void>;
  ensureVoiceFilterFrameChannel: () => Promise<boolean>;
  setGlobalPushKeybinds: (
    input: TDesktopPushKeybindsInput
  ) => Promise<TGlobalPushKeybindRegistrationResult>;
  pushVoiceFilterPcmFrame: (frame: TVoiceFilterPcmFrame) => void;
  pushVoiceFilterFrame: (frame: TVoiceFilterFrame) => void;
  subscribeAppAudioFrames: (
    cb: (frame: TAppAudioFrame | TAppAudioPcmFrame) => void
  ) => () => void;
  subscribeAppAudioStatus: (
    cb: (statusEvent: TAppAudioStatusEvent) => void
  ) => () => void;
  subscribeVoiceFilterFrames: (
    cb: (frame: TVoiceFilterFrame) => void
  ) => () => void;
  subscribeVoiceFilterStatus: (
    cb: (statusEvent: TVoiceFilterStatusEvent) => void
  ) => () => void;
  subscribeGlobalPushKeybindEvents: (
    cb: (event: TDesktopPushKeybindEvent) => void
  ) => () => void;
  subscribeUpdateStatus: (
    cb: (status: TDesktopUpdateStatus) => void
  ) => () => void;
  prepareScreenShare: (
    selection: TDesktopScreenShareSelection
  ) => Promise<TResolvedScreenAudioMode>;
};
