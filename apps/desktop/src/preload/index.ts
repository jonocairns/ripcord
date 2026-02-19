import { contextBridge, ipcRenderer } from "electron";
import type {
  TAppAudioFrame,
  TAppAudioSession,
  TAppAudioStatusEvent,
  TDesktopPushKeybindEvent,
  TDesktopPushKeybindsInput,
  TDesktopUpdateStatus,
  TGlobalPushKeybindRegistrationResult,
  TDesktopAppAudioTargetsResult,
  TScreenShareSelection,
  TStartAppAudioCaptureInput,
  TStartVoiceFilterInput,
  TVoiceFilterFrame,
  TVoiceFilterPcmFrame,
  TVoiceFilterSession,
  TVoiceFilterStatusEvent,
} from "../main/types";

const VOICE_FILTER_CHANNEL_INIT_TIMEOUT_MS = 3_000;
let voiceFilterFramePort: MessagePort | undefined;
let voiceFilterFramePortPromise: Promise<boolean> | undefined;

const encodePcmBase64 = (samples: Float32Array): string => {
  const bytes = new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
};

const toFallbackVoiceFilterFrame = (frame: TVoiceFilterPcmFrame): TVoiceFilterFrame => {
  return {
    sessionId: frame.sessionId,
    sequence: frame.sequence,
    sampleRate: frame.sampleRate,
    channels: frame.channels,
    frameCount: frame.frameCount,
    pcmBase64: encodePcmBase64(frame.pcm),
    protocolVersion: frame.protocolVersion,
    encoding: "f32le_base64",
  };
};

const ensureVoiceFilterFrameChannel = (): Promise<boolean> => {
  if (voiceFilterFramePort) {
    return Promise.resolve(true);
  }

  if (voiceFilterFramePortPromise) {
    return voiceFilterFramePortPromise;
  }

  voiceFilterFramePortPromise = new Promise<boolean>((resolve) => {
    let settled = false;
    const onPortReady = (event: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeout);

      const port = (event as { ports?: MessagePort[] }).ports?.[0];
      if (!port) {
        voiceFilterFramePortPromise = undefined;
        resolve(false);
        return;
      }

      voiceFilterFramePort = port;
      voiceFilterFramePort.onmessageerror = () => {
        voiceFilterFramePort = undefined;
      };

      try {
        voiceFilterFramePort.start();
      } catch {
        // ignore unsupported start() implementations
      }

      voiceFilterFramePortPromise = undefined;
      resolve(true);
    };

    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      ipcRenderer.removeListener(
        "desktop:voice-filter-frame-channel-ready",
        onPortReady,
      );
      voiceFilterFramePortPromise = undefined;
      resolve(false);
    }, VOICE_FILTER_CHANNEL_INIT_TIMEOUT_MS);
    ipcRenderer.once("desktop:voice-filter-frame-channel-ready", onPortReady);

    ipcRenderer.send("desktop:open-voice-filter-frame-channel");
  });

  return voiceFilterFramePortPromise;
};

const desktopBridge = {
  getServerUrl: (): Promise<string> =>
    ipcRenderer.invoke("desktop:get-server-url"),
  setServerUrl: (serverUrl: string): Promise<void> =>
    ipcRenderer.invoke("desktop:set-server-url", serverUrl),
  getCapabilities: () => ipcRenderer.invoke("desktop:get-capabilities"),
  pingSidecar: () => ipcRenderer.invoke("desktop:ping-sidecar"),
  getUpdateStatus: (): Promise<TDesktopUpdateStatus> =>
    ipcRenderer.invoke("desktop:get-update-status"),
  checkForUpdates: (): Promise<TDesktopUpdateStatus> =>
    ipcRenderer.invoke("desktop:check-for-updates"),
  installUpdateAndRestart: (): Promise<boolean> =>
    ipcRenderer.invoke("desktop:install-update-and-restart"),
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
  ensureVoiceFilterFrameChannel: (): Promise<boolean> =>
    ensureVoiceFilterFrameChannel(),
  setGlobalPushKeybinds: (
    input: TDesktopPushKeybindsInput,
  ): Promise<TGlobalPushKeybindRegistrationResult> =>
    ipcRenderer.invoke("desktop:set-global-push-keybinds", input),
  pushVoiceFilterPcmFrame: (frame: TVoiceFilterPcmFrame): void => {
    if (voiceFilterFramePort) {
      const { pcm } = frame;
      try {
        voiceFilterFramePort.postMessage(
          {
            sessionId: frame.sessionId,
            sequence: frame.sequence,
            sampleRate: frame.sampleRate,
            channels: frame.channels,
            frameCount: frame.frameCount,
            protocolVersion: frame.protocolVersion,
            pcmBuffer: pcm.buffer,
            pcmByteOffset: pcm.byteOffset,
            pcmByteLength: pcm.byteLength,
          },
          [pcm.buffer],
        );
        return;
      } catch {
        voiceFilterFramePort = undefined;
      }
    }

    void ensureVoiceFilterFrameChannel();
    ipcRenderer.send(
      "desktop:push-voice-filter-frame",
      toFallbackVoiceFilterFrame(frame),
    );
  },
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
  subscribeUpdateStatus: (callback: (status: TDesktopUpdateStatus) => void) => {
    const listener = (_event: unknown, status: TDesktopUpdateStatus) => {
      callback(status);
    };

    ipcRenderer.on("desktop:update-status", listener);

    return () => {
      ipcRenderer.removeListener("desktop:update-status", listener);
    };
  },
  prepareScreenShare: (selection: TScreenShareSelection) =>
    ipcRenderer.invoke("desktop:prepare-screen-share", selection),
};

contextBridge.exposeInMainWorld("sharkordDesktop", desktopBridge);
