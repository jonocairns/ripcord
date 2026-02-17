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
  experimentalRustCapture?: boolean;
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

export type TDesktopBridge = {
  getServerUrl: () => Promise<string>;
  setServerUrl: (serverUrl: string) => Promise<void>;
  getCapabilities: (options?: {
    experimentalRustCapture?: boolean;
  }) => Promise<TDesktopCapabilities>;
  pingSidecar: () => Promise<{ available: boolean; reason?: string }>;
  listShareSources: () => Promise<TDesktopShareSource[]>;
  listAppAudioTargets: (
    sourceId?: string
  ) => Promise<TDesktopAppAudioTargetsResult>;
  startAppAudioCapture: (
    input: TStartAppAudioCaptureInput
  ) => Promise<TAppAudioSession>;
  stopAppAudioCapture: (sessionId?: string) => Promise<void>;
  subscribeAppAudioFrames: (cb: (frame: TAppAudioFrame) => void) => () => void;
  subscribeAppAudioStatus: (
    cb: (statusEvent: TAppAudioStatusEvent) => void
  ) => () => void;
  prepareScreenShare: (
    selection: TDesktopScreenShareSelection
  ) => Promise<TResolvedScreenAudioMode>;
};
