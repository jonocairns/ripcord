import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  MessageChannelMain,
  type MessagePortMain,
  powerMonitor,
  session,
  shell,
} from "electron";
import fs from "node:fs";
import path from "path";
import { resolveDesktopCaptureCapabilities } from "./capture-capabilities";
import { captureSidecarManager } from "./capture-sidecar-manager";
import {
  getDesktopCapabilities,
  resolvePreparedScreenAudioMode,
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
import { installYoutubeEmbedRefererHandler } from "./youtube-embed-referrer";
import type {
  TAppAudioPcmFrame,
  TDesktopCapabilities,
  TDesktopQuitFlushResult,
  TDesktopPushKeybindEvent,
  TDesktopPushKeybindsInput,
  TDesktopWindowControlsState,
  TGlobalPushKeybindRegistrationResult,
  TScreenShareSelection,
  TStartAppAudioCaptureInput,
} from "./types";

const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
const DESKTOP_QUIT_FLUSH_TIMEOUT_MS = 2_000;
const DESKTOP_DEBUG_IPC_ENABLED = Boolean(RENDERER_URL);
const USES_CUSTOM_TITLEBAR =
  process.platform === "win32" || process.platform === "linux";
let mainWindow: BrowserWindow | null = null;
let appAudioFrameEgressPort: MessagePortMain | undefined;
let lastDesktopCapabilitiesSnapshot: string | undefined;
let refreshDesktopCapabilitiesPromise:
  | Promise<TDesktopCapabilities>
  | undefined;
let refreshDesktopCapabilitiesBroadcastPending = false;
let refreshDesktopCapabilitiesForceBroadcastPending = false;
let appIsShuttingDown = false;
let desktopQuitFlushInterceptInProgress = false;
let desktopQuitFlushCompleted = false;
let resolveDesktopQuitFlush:
  | ((result: TDesktopQuitFlushResult) => void)
  | undefined;

const sendToRenderer = (channel: string, ...args: unknown[]): boolean => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  ) {
    return false;
  }

  try {
    mainWindow.webContents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
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
  sendToRenderer("desktop:global-push-keybind", event);
};

const resolveDesktopPlatform = (): TDesktopWindowControlsState["platform"] => {
  if (process.platform === "darwin") {
    return "macos";
  }

  if (process.platform === "win32") {
    return "windows";
  }

  return "linux";
};

const getWindowControlsState = (): TDesktopWindowControlsState => {
  return {
    platform: resolveDesktopPlatform(),
    isMaximized: mainWindow?.isMaximized() ?? false,
    usesCustomTitlebar: USES_CUSTOM_TITLEBAR,
  };
};

const emitWindowControlsState = () => {
  sendToRenderer(
    "desktop:window-controls-state-changed",
    getWindowControlsState(),
  );
};

const disposeDesktopServicesForShutdown = () => {
  disposeAppAudioFrameEgressPort();
  desktopUpdater.dispose();
  void captureSidecarManager.dispose();
};

const completeDesktopQuitFlush = (result: TDesktopQuitFlushResult) => {
  if (!resolveDesktopQuitFlush) {
    return;
  }

  const resolve = resolveDesktopQuitFlush;
  resolveDesktopQuitFlush = undefined;
  resolve(result);
};

const requestDesktopQuitFlush = async (): Promise<TDesktopQuitFlushResult> => {
  if (!sendToRenderer("desktop:before-quit")) {
    return {
      status: "skipped",
      reason: "renderer-unavailable",
    };
  }

  return await new Promise<TDesktopQuitFlushResult>((resolve) => {
    const timeout = setTimeout(() => {
      resolveDesktopQuitFlush = undefined;
      resolve({
        status: "skipped",
        reason: "timeout",
      });
    }, DESKTOP_QUIT_FLUSH_TIMEOUT_MS);

    resolveDesktopQuitFlush = (result) => {
      clearTimeout(timeout);
      resolve(result);
    };
  });
};

const setGlobalPushKeybinds = async (
  input?: TDesktopPushKeybindsInput,
): Promise<TGlobalPushKeybindRegistrationResult> => {
  return await captureSidecarManager.setPushKeybinds(input || {});
};

const resolveSidecarStatusFromCapabilities = (
  sidecarCapabilities: Awaited<
    ReturnType<typeof captureSidecarManager.getCapabilities>
  >,
) => {
  if (
    sidecarCapabilities.platform === "macos" &&
    (sidecarCapabilities.systemAudio !== "supported" ||
      sidecarCapabilities.perAppAudio !== "supported")
  ) {
    return {
      available: false,
      reason:
        sidecarCapabilities.reason ||
        "macOS screen audio capture is unavailable.",
    };
  }

  return {
    available: true,
    reason: sidecarCapabilities.reason,
  };
};

const getEffectiveDesktopCapabilities = async () => {
  const baseCapabilities = getDesktopCapabilities();
  const sidecarCapabilities = await captureSidecarManager
    .getCapabilities()
    .catch(() => undefined);
  const sidecarStatus = sidecarCapabilities
    ? resolveSidecarStatusFromCapabilities(sidecarCapabilities)
    : await captureSidecarManager.getStatus();
  const sidecarPerAppAudioSupported = sidecarCapabilities
    ? sidecarCapabilities.perAppAudio !== "unsupported"
    : baseCapabilities.platform === "windows" && sidecarStatus.available;
  const sidecarReason =
    sidecarCapabilities?.perAppAudioReason ?? sidecarStatus.reason;

  return resolveDesktopCaptureCapabilities({
    baseCapabilities,
    sidecarAvailable: sidecarStatus.available,
    sidecarReason,
    sidecarPerAppAudioSupported,
    sidecarCapabilities,
  });
};

const refreshDesktopCapabilities = async (
  options: { broadcast?: boolean; forceBroadcast?: boolean } = {},
) => {
  refreshDesktopCapabilitiesBroadcastPending =
    refreshDesktopCapabilitiesBroadcastPending || options.broadcast === true;
  refreshDesktopCapabilitiesForceBroadcastPending =
    refreshDesktopCapabilitiesForceBroadcastPending ||
    options.forceBroadcast === true;

  if (refreshDesktopCapabilitiesPromise) {
    return await refreshDesktopCapabilitiesPromise;
  }

  refreshDesktopCapabilitiesPromise = (async () => {
    while (true) {
      const capabilities = await getEffectiveDesktopCapabilities();
      const snapshot = JSON.stringify(capabilities);
      const didChange = snapshot !== lastDesktopCapabilitiesSnapshot;
      lastDesktopCapabilitiesSnapshot = snapshot;

      const shouldBroadcast = refreshDesktopCapabilitiesBroadcastPending;
      const shouldForceBroadcast =
        refreshDesktopCapabilitiesForceBroadcastPending;
      refreshDesktopCapabilitiesBroadcastPending = false;
      refreshDesktopCapabilitiesForceBroadcastPending = false;

      if (shouldBroadcast && (shouldForceBroadcast || didChange)) {
        sendToRenderer("desktop:capabilities-changed", capabilities);
      }

      if (
        !refreshDesktopCapabilitiesBroadcastPending &&
        !refreshDesktopCapabilitiesForceBroadcastPending
      ) {
        return capabilities;
      }
    }
  })().finally(() => {
    refreshDesktopCapabilitiesPromise = undefined;
  });

  return await refreshDesktopCapabilitiesPromise;
};

const requestDesktopCapabilitiesRefresh = (
  options: { broadcast?: boolean; forceBroadcast?: boolean } = {},
) => {
  if (appIsShuttingDown) {
    return;
  }

  void refreshDesktopCapabilities(options).catch((error) => {
    console.warn("[desktop] Failed to refresh desktop capabilities", error);
  });
};

const createMainWindow = () => {
  const icon = resolveAppIconPath();
  let windowCloseFlushCompleted = false;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    frame: !USES_CUSTOM_TITLEBAR,
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
  mainWindow.on("maximize", () => {
    emitWindowControlsState();
  });
  mainWindow.on("unmaximize", () => {
    emitWindowControlsState();
  });
  mainWindow.on("focus", () => {
    requestDesktopCapabilitiesRefresh({
      broadcast: true,
    });
  });
  mainWindow.on("close", (event) => {
    const windowToClose = mainWindow;

    if (desktopQuitFlushCompleted || windowCloseFlushCompleted) {
      return;
    }

    event.preventDefault();

    if (desktopQuitFlushInterceptInProgress) {
      return;
    }

    desktopQuitFlushInterceptInProgress = true;

    void (async () => {
      const result = await requestDesktopQuitFlush();

      if (result.status === "skipped") {
        console.warn("[desktop] Window close flush skipped", {
          reason: result.reason,
        });
      }

      desktopQuitFlushInterceptInProgress = false;

      if (process.platform !== "darwin" || appIsShuttingDown) {
        appIsShuttingDown = true;
        desktopQuitFlushCompleted = true;
        app.quit();
        return;
      }

      windowCloseFlushCompleted = true;
      if (windowToClose && !windowToClose.isDestroyed()) {
        windowToClose.close();
      }
    })();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
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
          resizable: true,
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

          // Always provide loopback audio for system mode so that
          // getDisplayMedia can serve as a fallback when the sidecar is
          // unavailable or fails.  The client discards this track when the
          // sidecar successfully handles audio capture.
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

const setupYoutubeEmbedRefererHandler = () => {
  installYoutubeEmbedRefererHandler(session.defaultSession);
};

const registerIpcHandlers = () => {
  ipcMain.handle("desktop:get-server-url", () => {
    return getServerUrl();
  });

  ipcMain.handle("desktop:get-window-controls-state", () => {
    return getWindowControlsState();
  });

  ipcMain.handle(
    "desktop:minimize-window",
    (event: IpcMainInvokeEvent): void => {
      const window = BrowserWindow.fromWebContents(event.sender);
      window?.minimize();
    },
  );

  ipcMain.handle(
    "desktop:toggle-maximize-window",
    (event: IpcMainInvokeEvent): void => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return;
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
    },
  );

  ipcMain.handle("desktop:close-window", (event: IpcMainInvokeEvent): void => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.close();
  });

  ipcMain.handle(
    "desktop:set-server-url",
    (_event: IpcMainInvokeEvent, serverUrl: string) => {
      return setServerUrl(serverUrl);
    },
  );

  ipcMain.handle("desktop:get-capabilities", () => {
    return refreshDesktopCapabilities();
  });

  ipcMain.handle("desktop:get-system-idle-seconds", () => {
    return powerMonitor.getSystemIdleTime();
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
      return captureSidecarManager.startAppAudioCapture({
        ...input,
        selfExcludePid: process.pid,
      });
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

  ipcMain.on(
    "desktop:before-quit-finished",
    (_event: IpcMainEvent, result: TDesktopQuitFlushResult) => {
      completeDesktopQuitFlush(result);
    },
  );

  ipcMain.handle("desktop:debug-request-before-quit-flush", async () => {
    if (!DESKTOP_DEBUG_IPC_ENABLED) {
      return {
        status: "skipped",
        reason: "debug-unavailable",
      };
    }

    if (appIsShuttingDown || desktopQuitFlushInterceptInProgress) {
      return {
        status: "skipped",
        reason: "quit-in-progress",
      };
    }

    return await requestDesktopQuitFlush();
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
      const resolved = resolvePreparedScreenAudioMode(selection, capabilities);

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

      sendToRenderer("desktop:app-audio-frame", frame);
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
      sendToRenderer("desktop:app-audio-status", event);
    });
    captureSidecarManager.onPushKeybind((event) => {
      emitPushKeybindEvent(event);
    });
    captureSidecarManager.onLifecycle((event) => {
      if (appIsShuttingDown && event.kind === "exit") {
        return;
      }

      requestDesktopCapabilitiesRefresh({
        broadcast: true,
      });
    });

    desktopUpdater.start((status) => {
      sendToRenderer("desktop:update-status", status);
    });

    registerIpcHandlers();
    setupDisplayMediaHandler();
    setupYoutubeEmbedRefererHandler();
    createMainWindow();
    requestDesktopCapabilitiesRefresh({
      broadcast: true,
      forceBroadcast: true,
    });

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

app.on("before-quit", (event) => {
  appIsShuttingDown = true;

  if (desktopQuitFlushCompleted) {
    disposeDesktopServicesForShutdown();
    return;
  }

  event.preventDefault();

  if (desktopQuitFlushInterceptInProgress) {
    return;
  }

  desktopQuitFlushInterceptInProgress = true;

  void (async () => {
    const result = await requestDesktopQuitFlush();

    if (result.status === "skipped") {
      console.warn("[desktop] Quit flush skipped", {
        reason: result.reason,
      });
    }

    desktopQuitFlushInterceptInProgress = false;
    desktopQuitFlushCompleted = true;
    app.quit();
  })();
});
