import { contextBridge, ipcRenderer } from "electron";
import type {
  TAppAudioFrame,
  TAppAudioSession,
  TAppAudioStatusEvent,
  TDesktopAppAudioTargetsResult,
  TScreenShareSelection,
  TStartAppAudioCaptureInput,
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
  prepareScreenShare: (selection: TScreenShareSelection) =>
    ipcRenderer.invoke("desktop:prepare-screen-share", selection),
};

contextBridge.exposeInMainWorld("sharkordDesktop", desktopBridge);
