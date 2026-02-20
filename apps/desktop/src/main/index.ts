import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  MessageChannelMain,
  type MessagePortMain,
  session,
  shell,
} from "electron";
import fs from "node:fs";
import path from "path";
import { resolveDesktopCaptureCapabilities } from "./capture-capabilities";
import { captureSidecarManager } from "./capture-sidecar-manager";
import {
  getDesktopCapabilities,
  resolveScreenAudioMode,
} from "./platform-capabilities";
import {
  consumeScreenShareSelection,
  getSourceById,
  listShareSources,
  prepareScreenShareSelection,
} from "./screen-share";
import { getServerUrl, setServerUrl } from "./settings-store";
import { desktopUpdater } from "./updater";
import { classifyWindowOpenUrl } from "./window-open-policy";
import type {
  TAppAudioPcmFrame,
  TDesktopPushKeybindEvent,
  TDesktopPushKeybindsInput,
  TGlobalPushKeybindRegistrationResult,
  TScreenShareSelection,
  TStartAppAudioCaptureInput,
  TStartVoiceFilterInput,
  TVoiceFilterFrame,
  TVoiceFilterPcmFrame,
} from "./types";

const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
let mainWindow: BrowserWindow | null = null;
let appAudioFrameEgressPort: MessagePortMain | undefined;
let voiceFilterFrameIngressPort: MessagePortMain | undefined;
const VOICE_FILTER_INGRESS_DROP_LOG_RATE_LIMIT_MS = 2_000;
let nextVoiceFilterIngressDropLogAt = 0;

const logVoiceFilterIngressDrop = (
  reason: string,
  details?: Record<string, unknown>,
): void => {
  const now = Date.now();
  if (now < nextVoiceFilterIngressDropLogAt) {
    return;
  }

  nextVoiceFilterIngressDropLogAt = now + VOICE_FILTER_INGRESS_DROP_LOG_RATE_LIMIT_MS;
  console.warn("[voice-filter-debug] Dropping voice-filter ingress frame", {
    reason,
    ...(details || {}),
  });
};

const disposeAppAudioFrameEgressPort = (
  port: MessagePortMain | undefined = appAudioFrameEgressPort,
): void => {
  if (!port) {
    return;
  }

  if (appAudioFrameEgressPort === port) {
    appAudioFrameEgressPort = undefined;
  }

  try {
    port.close();
  } catch {
    // ignore
  }

  port.removeAllListeners();
};

const disposeVoiceFilterFrameIngressPort = (
  port: MessagePortMain | undefined = voiceFilterFrameIngressPort,
): void => {
  if (!port) {
    return;
  }

  if (voiceFilterFrameIngressPort === port) {
    voiceFilterFrameIngressPort = undefined;
  }

  try {
    port.close();
  } catch {
    // ignore
  }

  port.removeAllListeners();
};

if (process.platform === "win32") {
  app.setAppUserModelId("com.sharkord.desktop");
}

const resolveAppIconPath = (): string | undefined => {
  const iconFile = process.platform === "win32" ? "icon.ico" : "icon.png";
  const iconPath = path.join(__dirname, "..", "..", "assets", "icons", iconFile);

  if (!fs.existsSync(iconPath)) {
    return undefined;
  }

  return iconPath;
};

const emitPushKeybindEvent = (event: TDesktopPushKeybindEvent) => {
  mainWindow?.webContents.send("desktop:global-push-keybind", event);
};

const setGlobalPushKeybinds = async (
  input?: TDesktopPushKeybindsInput,
): Promise<TGlobalPushKeybindRegistrationResult> => {
  return await captureSidecarManager.setPushKeybinds(input || {});
};

const getEffectiveDesktopCapabilities = async () => {
  const baseCapabilities = getDesktopCapabilities();
  const sidecarStatus = await captureSidecarManager.getStatus();

  return resolveDesktopCaptureCapabilities({
    baseCapabilities,
    sidecarAvailable: sidecarStatus.available,
    sidecarReason: sidecarStatus.reason,
  });
};

const createMainWindow = () => {
  const icon = resolveAppIconPath();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#090d12",
    icon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "..", "preload", "index.cjs"),
    },
  });
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const policy = classifyWindowOpenUrl(url);

    if (policy.action === "allow") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          icon,
          autoHideMenuBar: true,
          backgroundColor: "#000000",
        },
      };
    }

    if (policy.openExternal) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });

  mainWindow.webContents.on("did-create-window", (childWindow, details) => {
    if (!details.url.startsWith("about:blank")) {
      return;
    }

    childWindow.setAutoHideMenuBar(true);
    childWindow.setMenuBarVisibility(false);
  });

  if (RENDERER_URL) {
    void mainWindow.loadURL(RENDERER_URL);
    return;
  }

  const indexPath = path.join(
    __dirname,
    "..",
    "..",
    "renderer-dist",
    "index.html",
  );
  void mainWindow.loadFile(indexPath);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

const setupDisplayMediaHandler = () => {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void (async () => {
        const rejectRequest = () => {
          callback({
            video: undefined,
            audio: undefined,
          });
        };

        try {
          const pendingSelection = consumeScreenShareSelection();

          if (!pendingSelection) {
            rejectRequest();
            return;
          }

          const source = await getSourceById(pendingSelection.sourceId);

          if (!source) {
            rejectRequest();
            return;
          }

          // In hybrid v1 we keep display media audio only for system mode.
          const shouldShareAudio = pendingSelection.audioMode === "system";

          callback({
            video: source,
            audio: shouldShareAudio ? "loopback" : undefined,
          });
        } catch (error) {
          console.error(
            "[desktop] Failed to handle display media request",
            error,
          );
          rejectRequest();
        }
      })();
    },
    {
      useSystemPicker: false,
    },
  );
};

const registerIpcHandlers = () => {
  ipcMain.handle("desktop:get-server-url", () => {
    return getServerUrl();
  });

  ipcMain.handle(
    "desktop:set-server-url",
    (_event: IpcMainInvokeEvent, serverUrl: string) => {
      return setServerUrl(serverUrl);
    },
  );

  ipcMain.handle(
    "desktop:get-capabilities",
    () => {
      return getEffectiveDesktopCapabilities();
    },
  );

  ipcMain.handle("desktop:list-app-audio-targets", (_event, sourceId?: string) => {
    return captureSidecarManager.listAppAudioTargets(sourceId);
  });

  ipcMain.handle(
    "desktop:start-app-audio-capture",
    (_event, input: TStartAppAudioCaptureInput) => {
      return captureSidecarManager.startAppAudioCapture(input);
    },
  );

  ipcMain.handle(
    "desktop:stop-app-audio-capture",
    (_event, sessionId?: string) => {
      return captureSidecarManager.stopAppAudioCapture(sessionId);
    },
  );

  ipcMain.handle(
    "desktop:start-voice-filter-session",
    (_event, input: TStartVoiceFilterInput) => {
      return captureSidecarManager.startVoiceFilterSession(input);
    },
  );

  ipcMain.handle(
    "desktop:stop-voice-filter-session",
    (_event, sessionId?: string) => {
      return captureSidecarManager.stopVoiceFilterSession(sessionId);
    },
  );

  ipcMain.handle(
    "desktop:set-global-push-keybinds",
    async (_event, input?: TDesktopPushKeybindsInput) => {
      return await setGlobalPushKeybinds(input);
    },
  );

  ipcMain.on(
    "desktop:push-voice-filter-frame",
    (_event: IpcMainEvent, frame: TVoiceFilterFrame) => {
      captureSidecarManager.pushVoiceFilterFrame(frame);
    },
  );

  ipcMain.on("desktop:open-app-audio-frame-channel", (event: IpcMainEvent) => {
    const { port1, port2 } = new MessageChannelMain();
    disposeAppAudioFrameEgressPort();

    appAudioFrameEgressPort = port2;
    port2.on("close", () => {
      if (appAudioFrameEgressPort === port2) {
        appAudioFrameEgressPort = undefined;
      }
      port2.removeAllListeners();
    });

    port2.start();
    event.sender.postMessage("desktop:app-audio-frame-channel-ready", null, [port1]);
  });

  ipcMain.on("desktop:open-voice-filter-frame-channel", (event: IpcMainEvent) => {
    const { port1, port2 } = new MessageChannelMain();
    disposeVoiceFilterFrameIngressPort();
    voiceFilterFrameIngressPort = port2;

    port2.on("message", (portEvent) => {
      const data = portEvent.data as
        | {
            sessionId?: unknown;
            sequence?: unknown;
            sampleRate?: unknown;
            channels?: unknown;
            frameCount?: unknown;
            protocolVersion?: unknown;
            pcmSamples?: unknown;
            pcmBuffer?: unknown;
            pcmByteOffset?: unknown;
            pcmByteLength?: unknown;
          }
        | undefined;

      if (!data || typeof data !== "object") {
        return;
      }

      const {
        sessionId,
        sequence,
        sampleRate,
        channels,
        frameCount,
        protocolVersion,
        pcmSamples,
        pcmBuffer,
        pcmByteOffset,
        pcmByteLength,
      } = data;

      let pcm: Float32Array | undefined;
      let pcmSampleCount: number | undefined;

      const pcmBufferSource =
        pcmBuffer instanceof ArrayBuffer
          ? {
              buffer: pcmBuffer as ArrayBufferLike,
              baseByteOffset: 0,
              byteLength: pcmBuffer.byteLength,
            }
          : ArrayBuffer.isView(pcmBuffer)
            ? {
                buffer: pcmBuffer.buffer,
                baseByteOffset: pcmBuffer.byteOffset,
                byteLength: pcmBuffer.byteLength,
              }
            : undefined;

      const hasPcmSamplesPayload =
        pcmSamples instanceof Float32Array ||
        ArrayBuffer.isView(pcmSamples) ||
        Array.isArray(pcmSamples);

      if (
        typeof sessionId !== "string" ||
        typeof sequence !== "number" ||
        typeof sampleRate !== "number" ||
        typeof channels !== "number" ||
        typeof frameCount !== "number" ||
        !hasPcmSamplesPayload &&
          !pcmBufferSource
      ) {
        logVoiceFilterIngressDrop("invalid_header_or_buffer_type", {
          sessionIdType: typeof sessionId,
          sequenceType: typeof sequence,
          sampleRateType: typeof sampleRate,
          channelsType: typeof channels,
          frameCountType: typeof frameCount,
          pcmSamplesType:
            pcmSamples === null
              ? "null"
              : Array.isArray(pcmSamples)
                ? "array"
                : typeof pcmSamples,
          pcmSamplesCtor:
            pcmSamples &&
            typeof pcmSamples === "object" &&
            "constructor" in pcmSamples
              ? (
                  pcmSamples as {
                    constructor?: { name?: unknown };
                  }
                ).constructor?.name
              : undefined,
          pcmBufferType:
            pcmBuffer === null
              ? "null"
              : Array.isArray(pcmBuffer)
                ? "array"
                : typeof pcmBuffer,
          pcmBufferCtor:
            pcmBuffer && typeof pcmBuffer === "object" && "constructor" in pcmBuffer
              ? (
                  pcmBuffer as {
                    constructor?: { name?: unknown };
                  }
                ).constructor?.name
              : undefined,
        });
        return;
      }

      const expectedSampleCount = frameCount * channels;

      if (pcmSamples instanceof Float32Array) {
        pcm = new Float32Array(pcmSamples);
        pcmSampleCount = pcm.length;
      } else if (ArrayBuffer.isView(pcmSamples)) {
        const sampleView = new Float32Array(
          pcmSamples.buffer,
          pcmSamples.byteOffset,
          Math.floor(pcmSamples.byteLength / Float32Array.BYTES_PER_ELEMENT),
        );
        pcm = new Float32Array(sampleView);
        pcmSampleCount = pcm.length;
      } else if (Array.isArray(pcmSamples)) {
        pcm = Float32Array.from(pcmSamples);
        pcmSampleCount = pcm.length;
      }

      if (!pcm) {
        if (!pcmBufferSource) {
          logVoiceFilterIngressDrop("missing_pcm_payload", {
            sessionId,
            sequence,
          });
          return;
        }

        const relativeByteOffset =
          typeof pcmByteOffset === "number" && Number.isInteger(pcmByteOffset)
            ? pcmByteOffset
            : 0;
        const byteLength =
          typeof pcmByteLength === "number" && Number.isInteger(pcmByteLength)
            ? pcmByteLength
            : pcmBufferSource.byteLength;

        if (
          relativeByteOffset < 0 ||
          byteLength <= 0 ||
          relativeByteOffset + byteLength > pcmBufferSource.byteLength ||
          byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
        ) {
          logVoiceFilterIngressDrop("invalid_pcm_bounds", {
            relativeByteOffset,
            byteLength,
            pcmBufferByteLength: pcmBufferSource.byteLength,
          });
          return;
        }

        const absoluteByteOffset = pcmBufferSource.baseByteOffset + relativeByteOffset;
        try {
          const pcmBytes = new Uint8Array(
            pcmBufferSource.buffer,
            absoluteByteOffset,
            byteLength,
          );
          const alignedPcmBytes = new Uint8Array(byteLength);
          alignedPcmBytes.set(pcmBytes);
          pcm = new Float32Array(alignedPcmBytes.buffer);
        } catch (error) {
          logVoiceFilterIngressDrop("failed_to_construct_pcm_view", {
            absoluteByteOffset,
            byteLength,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }

      if (pcmSampleCount !== undefined && pcmSampleCount !== expectedSampleCount) {
        logVoiceFilterIngressDrop("invalid_pcm_samples_length", {
          expectedSampleCount,
          actualSampleCount: pcmSampleCount,
        });
        return;
      }

      const frame: TVoiceFilterPcmFrame = {
        sessionId,
        sequence,
        sampleRate,
        channels,
        frameCount,
        protocolVersion: typeof protocolVersion === "number" ? protocolVersion : 1,
        pcm,
      };

      captureSidecarManager.pushVoiceFilterPcmFrame(frame);
    });

    port2.on("close", () => {
      if (voiceFilterFrameIngressPort === port2) {
        voiceFilterFrameIngressPort = undefined;
      }
      port2.removeAllListeners();
    });

    port2.start();
    event.sender.postMessage("desktop:voice-filter-frame-channel-ready", null, [port1]);
  });

  ipcMain.handle("desktop:ping-sidecar", () => {
    return captureSidecarManager.getStatus();
  });

  ipcMain.handle("desktop:get-update-status", () => {
    return desktopUpdater.getStatus();
  });

  ipcMain.handle("desktop:check-for-updates", async () => {
    await desktopUpdater.checkForUpdates();
    return desktopUpdater.getStatus();
  });

  ipcMain.handle("desktop:install-update-and-restart", () => {
    return desktopUpdater.installUpdateAndRestart();
  });

  ipcMain.handle("desktop:list-share-sources", () => {
    return listShareSources();
  });

  ipcMain.handle(
    "desktop:prepare-screen-share",
    async (_event: IpcMainInvokeEvent, selection: TScreenShareSelection) => {
      const capabilities = await getEffectiveDesktopCapabilities();
      let resolved = resolveScreenAudioMode(
        selection.audioMode,
        capabilities,
      );

      if (
        resolved.effectiveMode === "app" &&
        selection.sourceId.startsWith("screen:") &&
        !selection.appAudioTargetId
      ) {
        const fallbackMode =
          capabilities.systemAudio === "unsupported" ? "none" : "system";

        resolved = {
          requestedMode: selection.audioMode,
          effectiveMode: fallbackMode,
          warning:
            fallbackMode === "none"
              ? "Per-app audio requires selecting a target app. Continuing without shared audio."
              : "Per-app audio requires selecting a target app. Falling back to system audio.",
        };
      }

      prepareScreenShareSelection({
        sourceId: selection.sourceId,
        audioMode: resolved.effectiveMode,
        appAudioTargetId: selection.appAudioTargetId,
      });

      return resolved;
    },
  );
};

void app
  .whenReady()
  .then(() => {
    captureSidecarManager.onFrame((frame) => {
      if (appAudioFrameEgressPort) {
        return;
      }

      mainWindow?.webContents.send("desktop:app-audio-frame", frame);
    });
    captureSidecarManager.onPcmFrame((frame: TAppAudioPcmFrame) => {
      const egressPort = appAudioFrameEgressPort;
      if (!egressPort) {
        return;
      }

      const { pcm } = frame;
      try {
        egressPort.postMessage(
          {
            sessionId: frame.sessionId,
            targetId: frame.targetId,
            sequence: frame.sequence,
            sampleRate: frame.sampleRate,
            channels: frame.channels,
            frameCount: frame.frameCount,
            protocolVersion: frame.protocolVersion,
            droppedFrameCount: frame.droppedFrameCount,
            pcmBuffer: pcm.buffer,
            pcmByteOffset: pcm.byteOffset,
            pcmByteLength: pcm.byteLength,
          }
        );
      } catch {
        disposeAppAudioFrameEgressPort(egressPort);
      }
    });
    captureSidecarManager.onStatus((event) => {
      mainWindow?.webContents.send("desktop:app-audio-status", event);
    });
    captureSidecarManager.onVoiceFilterFrame((frame) => {
      mainWindow?.webContents.send("desktop:voice-filter-frame", frame);
    });
    captureSidecarManager.onVoiceFilterStatus((event) => {
      mainWindow?.webContents.send("desktop:voice-filter-status", event);
    });
    captureSidecarManager.onPushKeybind((event) => {
      emitPushKeybindEvent(event);
    });

    desktopUpdater.start((status) => {
      mainWindow?.webContents.send("desktop:update-status", status);
    });

    registerIpcHandlers();
    setupDisplayMediaHandler();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  })
  .catch((error) => {
    console.error("[desktop] Failed to initialize app", error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  disposeAppAudioFrameEgressPort();
  disposeVoiceFilterFrameIngressPort();

  desktopUpdater.dispose();
  void captureSidecarManager.dispose();
});
