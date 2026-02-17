import {
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  session,
  shell,
} from "electron";
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
import type { TScreenShareSelection, TStartAppAudioCaptureInput } from "./types";

const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
let mainWindow: BrowserWindow | null = null;

const getEffectiveDesktopCapabilities = async (
  experimentalRustCapture = true,
) => {
  const baseCapabilities = getDesktopCapabilities();
  const sidecarStatus = await captureSidecarManager.getStatus();

  return resolveDesktopCaptureCapabilities({
    baseCapabilities,
    sidecarAvailable: sidecarStatus.available,
    sidecarReason: sidecarStatus.reason,
    experimentalRustCapture,
  });
};

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: "#090d12",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "..", "preload", "index.cjs"),
    },
  });

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
    (_event: IpcMainInvokeEvent, options?: { experimentalRustCapture?: boolean }) => {
      return getEffectiveDesktopCapabilities(
        options?.experimentalRustCapture ?? true,
      );
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

  ipcMain.handle("desktop:ping-sidecar", () => {
    return captureSidecarManager.getStatus();
  });

  ipcMain.handle("desktop:list-share-sources", () => {
    return listShareSources();
  });

  ipcMain.handle(
    "desktop:prepare-screen-share",
    async (_event: IpcMainInvokeEvent, selection: TScreenShareSelection) => {
      const capabilities = await getEffectiveDesktopCapabilities(
        selection.experimentalRustCapture ?? true,
      );
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
  void captureSidecarManager.dispose();
});
