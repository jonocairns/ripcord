export type TDesktopPlatform = "windows" | "macos" | "linux";

export type TSupportLevel = "supported" | "best-effort" | "unsupported";

export type TScreenAudioMode = "system" | "app" | "none";

export type TShareSourceKind = "screen" | "window";

export type TShareSource = {
  id: string;
  name: string;
  kind: TShareSourceKind;
  thumbnailDataUrl: string;
  appIconDataUrl?: string;
};

export type TScreenShareSelection = {
  sourceId: string;
  audioMode: TScreenAudioMode;
  appAudioTargetId?: string;
  experimentalRustCapture?: boolean;
};

export type TDesktopCapabilities = {
  platform: TDesktopPlatform;
  systemAudio: TSupportLevel;
  perAppAudio: TSupportLevel;
  sidecarAvailable?: boolean;
  notes: string[];
};

export type TPreparedScreenShare = {
  sourceId: string;
  audioMode: TScreenAudioMode;
  appAudioTargetId?: string;
};

export type TResolvedScreenAudioMode = {
  requestedMode: TScreenAudioMode;
  effectiveMode: TScreenAudioMode;
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
  encoding?: "f32le_base64";
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
  encoding: "f32le_base64";
  droppedFrameCount?: number;
};

export type TAppAudioEndReason =
  | "capture_stopped"
  | "app_exited"
  | "capture_error"
  | "device_lost"
  | "sidecar_exited";

export type TAppAudioStatusEvent = {
  sessionId: string;
  targetId: string;
  reason: TAppAudioEndReason;
  error?: string;
  protocolVersion?: number;
};
