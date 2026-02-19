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
import type {
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
let voiceFilterFrameIngressPort: MessagePortMain | undefined;

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
    void shell.openExternal(url);
    return { action: "deny" };
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
    (_event: IpcMainInvokeEvent) => {
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

  ipcMain.on("desktop:open-voice-filter-frame-channel", (event: IpcMainEvent) => {
    const { port1, port2 } = new MessageChannelMain();
    if (voiceFilterFrameIngressPort) {
      try {
        voiceFilterFrameIngressPort.close();
      } catch {
        // ignore
      }
      voiceFilterFrameIngressPort.removeAllListeners();
    }
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
        pcmBuffer,
        pcmByteOffset,
        pcmByteLength,
      } = data;

      if (
        typeof sessionId !== "string" ||
        typeof sequence !== "number" ||
        typeof sampleRate !== "number" ||
        typeof channels !== "number" ||
        typeof frameCount !== "number" ||
        !(pcmBuffer instanceof ArrayBuffer)
      ) {
        return;
      }

      const byteOffset =
        typeof pcmByteOffset === "number" && Number.isInteger(pcmByteOffset)
          ? pcmByteOffset
          : 0;
      const byteLength =
        typeof pcmByteLength === "number" && Number.isInteger(pcmByteLength)
          ? pcmByteLength
          : pcmBuffer.byteLength;

      if (
        byteOffset < 0 ||
        byteLength <= 0 ||
        byteOffset + byteLength > pcmBuffer.byteLength ||
        byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
      ) {
        return;
      }

      const frame: TVoiceFilterPcmFrame = {
        sessionId,
        sequence,
        sampleRate,
        channels,
        frameCount,
        protocolVersion: typeof protocolVersion === "number" ? protocolVersion : 1,
        pcm: new Float32Array(
          pcmBuffer,
          byteOffset,
          byteLength / Float32Array.BYTES_PER_ELEMENT,
        ),
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
      mainWindow?.webContents.send("desktop:app-audio-frame", frame);
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
  if (voiceFilterFrameIngressPort) {
    try {
      voiceFilterFrameIngressPort.close();
    } catch {
      // ignore
    }
    voiceFilterFrameIngressPort.removeAllListeners();
    voiceFilterFrameIngressPort = undefined;
  }

  desktopUpdater.dispose();
  void captureSidecarManager.dispose();
});
