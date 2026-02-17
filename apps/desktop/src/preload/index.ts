import { contextBridge, ipcRenderer } from "electron";
import type {
  TAppAudioFrame,
  TAppAudioSession,
  TAppAudioStatusEvent,
  TDesktopPushKeybindEvent,
  TDesktopPushKeybindsInput,
  TGlobalPushKeybindRegistrationResult,
  TDesktopAppAudioTargetsResult,
  TScreenShareSelection,
  TStartAppAudioCaptureInput,
  TStartVoiceFilterInput,
  TVoiceFilterFrame,
  TVoiceFilterSession,
  TVoiceFilterStatusEvent,
} from "../main/types";

const desktopBridge = {
  getServerUrl: (): Promise<string> =>
    ipcRenderer.invoke("desktop:get-server-url"),
  setServerUrl: (serverUrl: string): Promise<void> =>
    ipcRenderer.invoke("desktop:set-server-url", serverUrl),
  getCapabilities: (options?: { experimentalRustCapture?: boolean }) =>
    ipcRenderer.invoke("desktop:get-capabilities", options),
  pingSidecar: () => ipcRenderer.invoke("desktop:ping-sidecar"),
  listShareSources: () => ipcRenderer.invoke("desktop:list-share-sources"),
  listAppAudioTargets: (sourceId?: string): Promise<TDesktopAppAudioTargetsResult> =>
    ipcRenderer.invoke("desktop:list-app-audio-targets", sourceId),
  startAppAudioCapture: (input: TStartAppAudioCaptureInput): Promise<TAppAudioSession> =>
    ipcRenderer.invoke("desktop:start-app-audio-capture", input),
  stopAppAudioCapture: (sessionId?: string): Promise<void> =>
    ipcRenderer.invoke("desktop:stop-app-audio-capture", sessionId),
  startVoiceFilterSession: (
    input: TStartVoiceFilterInput,
  ): Promise<TVoiceFilterSession> =>
    ipcRenderer.invoke("desktop:start-voice-filter-session", input),
  stopVoiceFilterSession: (sessionId?: string): Promise<void> =>
    ipcRenderer.invoke("desktop:stop-voice-filter-session", sessionId),
  setGlobalPushKeybinds: (
    input: TDesktopPushKeybindsInput,
  ): Promise<TGlobalPushKeybindRegistrationResult> =>
    ipcRenderer.invoke("desktop:set-global-push-keybinds", input),
  pushVoiceFilterFrame: (frame: TVoiceFilterFrame): void => {
    ipcRenderer.send("desktop:push-voice-filter-frame", frame);
  },
  subscribeAppAudioFrames: (callback: (frame: TAppAudioFrame) => void) => {
    const listener = (_event: unknown, frame: TAppAudioFrame) => {
      callback(frame);
    };

    ipcRenderer.on("desktop:app-audio-frame", listener);

    return () => {
      ipcRenderer.removeListener("desktop:app-audio-frame", listener);
    };
  },
  subscribeAppAudioStatus: (
    callback: (statusEvent: TAppAudioStatusEvent) => void,
  ) => {
    const listener = (_event: unknown, statusEvent: TAppAudioStatusEvent) => {
      callback(statusEvent);
    };

    ipcRenderer.on("desktop:app-audio-status", listener);

    return () => {
      ipcRenderer.removeListener("desktop:app-audio-status", listener);
    };
  },
  subscribeVoiceFilterFrames: (callback: (frame: TVoiceFilterFrame) => void) => {
    const listener = (_event: unknown, frame: TVoiceFilterFrame) => {
      callback(frame);
    };

    ipcRenderer.on("desktop:voice-filter-frame", listener);

    return () => {
      ipcRenderer.removeListener("desktop:voice-filter-frame", listener);
    };
  },
  subscribeVoiceFilterStatus: (
    callback: (statusEvent: TVoiceFilterStatusEvent) => void,
  ) => {
    const listener = (_event: unknown, statusEvent: TVoiceFilterStatusEvent) => {
      callback(statusEvent);
    };

    ipcRenderer.on("desktop:voice-filter-status", listener);

    return () => {
      ipcRenderer.removeListener("desktop:voice-filter-status", listener);
    };
  },
  subscribeGlobalPushKeybindEvents: (
    callback: (event: TDesktopPushKeybindEvent) => void,
  ) => {
    const listener = (_ipcEvent: unknown, event: TDesktopPushKeybindEvent) => {
      callback(event);
    };

    ipcRenderer.on("desktop:global-push-keybind", listener);

    return () => {
      ipcRenderer.removeListener("desktop:global-push-keybind", listener);
    };
  },
  prepareScreenShare: (selection: TScreenShareSelection) =>
    ipcRenderer.invoke("desktop:prepare-screen-share", selection),
};

contextBridge.exposeInMainWorld("sharkordDesktop", desktopBridge);
