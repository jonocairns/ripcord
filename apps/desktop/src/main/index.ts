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
import { previewRuntimeConfig } from "./preview-runtime-config";
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
} from "./types";

const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
let mainWindow: BrowserWindow | null = null;
let appAudioFrameEgressPort: MessagePortMain | undefined;

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

if (process.platform === "win32") {
  app.setAppUserModelId(
    previewRuntimeConfig?.appUserModelId || "com.sharkord.desktop",
  );
}

const resolveAppIconPath = (): string | undefined => {
  const iconFile = process.platform === "win32" ? "icon.ico" : "icon.png";
  const iconPath = path.join(
    __dirname,
    "..",
    "..",
    "assets",
    "icons",
    iconFile,
  );

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
          frame: false,
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

  ipcMain.handle("desktop:get-capabilities", () => {
    return getEffectiveDesktopCapabilities();
  });

  ipcMain.handle(
    "desktop:list-app-audio-targets",
    (_event, sourceId?: string) => {
      return captureSidecarManager.listAppAudioTargets(sourceId);
    },
  );

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
    "desktop:set-global-push-keybinds",
    async (_event, input?: TDesktopPushKeybindsInput) => {
      return await setGlobalPushKeybinds(input);
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
    event.sender.postMessage("desktop:app-audio-frame-channel-ready", null, [
      port1,
    ]);
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

  ipcMain.handle("desktop:list-share-sources", () => {
    return listShareSources();
  });

  ipcMain.handle(
    "desktop:prepare-screen-share",
    async (_event: IpcMainInvokeEvent, selection: TScreenShareSelection) => {
      const capabilities = await getEffectiveDesktopCapabilities();
      let resolved = resolveScreenAudioMode(selection.audioMode, capabilities);

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
        egressPort.postMessage({
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
        });
      } catch {
        disposeAppAudioFrameEgressPort(egressPort);
      }
    });
    captureSidecarManager.onStatus((event) => {
      mainWindow?.webContents.send("desktop:app-audio-status", event);
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

  desktopUpdater.dispose();
  void captureSidecarManager.dispose();
});
