import fs from "node:fs";
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
import path from "path";
import { resolveDesktopCaptureCapabilities } from "./capture-capabilities";
import { captureSidecarManager } from "./capture-sidecar-manager";
import {
  validateDesktopQuitFlushResultArgs,
  validateListAppAudioTargetsArgs,
  validatePrepareScreenShareArgs,
  validateSetGlobalPushKeybindsArgs,
  validateSetServerUrlArgs,
  validateStartAppAudioCaptureArgs,
  validateStopAppAudioCaptureArgs,
} from "./ipc-validators";
import { classifyMainFrameNavigationUrl } from "./navigation-policy";
import { isPermissionAllowed } from "./permission-policy";
import {
  getDesktopCapabilities,
  resolvePreparedScreenAudioMode,
} from "./platform-capabilities";
import { previewRuntimeConfig } from "./preview-runtime-config";
import { installPackagedRendererCspReportOnlyHandler } from "./renderer-csp";
import {
  isTrustedRendererUrl,
  type TRendererTrustOptions,
} from "./renderer-trust";
import {
  consumeScreenShareSelection,
  getSourceById,
  listShareSources,
  prepareScreenShareSelection,
} from "./screen-share";
import { getServerUrl, setServerUrl } from "./settings-store";
import type {
  TAppAudioPcmFrame,
  TDesktopCapabilities,
  TDesktopPushKeybindEvent,
  TDesktopPushKeybindsInput,
  TDesktopQuitFlushResult,
  TDesktopWindowControlsState,
  TGlobalPushKeybindRegistrationResult,
  TScreenShareSelection,
  TStartAppAudioCaptureInput,
} from "./types";
import { desktopUpdater } from "./updater";
import { resolveVideoEncodeCapabilities } from "./video-encode-capabilities";
import { classifyWindowOpenUrl } from "./window-open-policy";
import { installYoutubeEmbedRefererHandler } from "./youtube-embed-referrer";

const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
const TRUSTED_RENDERER_URL = app.isPackaged ? undefined : RENDERER_URL;
const DESKTOP_QUIT_FLUSH_TIMEOUT_MS = 2_000;
const DESKTOP_DEBUG_IPC_ENABLED = Boolean(TRUSTED_RENDERER_URL);
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

const resolveRendererIndexPath = (): string => {
  return path.join(__dirname, "..", "..", "renderer-dist", "index.html");
};

const rendererTrustOptions: TRendererTrustOptions = {
  packagedIndexPath: resolveRendererIndexPath(),
  rendererUrl: TRUSTED_RENDERER_URL,
};

const isTrustedIpcSender = (
  event: IpcMainInvokeEvent | IpcMainEvent,
): boolean => {
  const senderUrl = event.senderFrame?.url;

  if (senderUrl && isTrustedRendererUrl(senderUrl, rendererTrustOptions)) {
    return true;
  }

  console.warn("[desktop] Rejected IPC message from untrusted sender", {
    senderUrl,
  });

  return false;
};

const assertTrustedIpcSender = (event: IpcMainInvokeEvent): void => {
  if (!isTrustedIpcSender(event)) {
    throw new Error("Rejected IPC message from an untrusted sender frame");
  }
};

const handleTrusted = <TArgs extends unknown[], TResult>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult,
  validateArgs?: (args: unknown[]) => TArgs,
): void => {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event);
    const validatedArgs = validateArgs ? validateArgs(args) : (args as TArgs);
    return listener(event, ...validatedArgs);
  });
};

const onTrusted = <TArgs extends unknown[]>(
  channel: string,
  listener: (event: IpcMainEvent, ...args: TArgs) => void,
  validateArgs?: (args: unknown[]) => TArgs,
): void => {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedIpcSender(event)) {
      return;
    }

    try {
      const validatedArgs = validateArgs ? validateArgs(args) : (args as TArgs);
      listener(event, ...validatedArgs);
    } catch (error) {
      console.warn("[desktop] Rejected IPC message with invalid payload", {
        channel,
        error,
      });
    }
  });
};

const createMainWindow = () => {
  const icon = resolveAppIconPath();
  const indexPath = resolveRendererIndexPath();
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

  mainWindow.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) {
      return;
    }

    const policy = classifyMainFrameNavigationUrl(event.url, {
      packagedIndexPath: indexPath,
      rendererUrl: TRUSTED_RENDERER_URL,
    });

    if (policy.action === "allow") {
      return;
    }

    event.preventDefault();

    if (policy.openExternal) {
      void shell.openExternal(event.url);
    }
  });

  mainWindow.webContents.on("did-create-window", (childWindow, details) => {
    if (!details.url.startsWith("about:blank")) {
      return;
    }

    childWindow.setAutoHideMenuBar(true);
    childWindow.setMenuBarVisibility(false);
  });

  if (TRUSTED_RENDERER_URL) {
    void mainWindow.loadURL(TRUSTED_RENDERER_URL);
    return;
  }

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

const isTrustedPermissionRequester = (
  requestingUrl: string | undefined | null,
): boolean => {
  if (!requestingUrl) {
    return false;
  }

  return isTrustedRendererUrl(requestingUrl, rendererTrustOptions);
};

const setupPermissionHandlers = () => {
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const requestingUrl = details?.requestingUrl ?? webContents?.getURL();
      const allowed = isPermissionAllowed(permission, {
        isTrustedRequester: isTrustedPermissionRequester(requestingUrl),
      });

      if (!allowed) {
        console.warn("[desktop] Denied permission request", {
          permission,
          requestingUrl,
        });
      }

      callback(allowed);
    },
  );

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) => {
      return isPermissionAllowed(permission, {
        isTrustedRequester: isTrustedPermissionRequester(
          details?.requestingUrl ?? requestingOrigin,
        ),
      });
    },
  );
};

const setupYoutubeEmbedRefererHandler = () => {
  installYoutubeEmbedRefererHandler(session.defaultSession);
};

const setupPackagedRendererCspHandler = () => {
  if (RENDERER_URL) {
    return;
  }

  const rendererDistPath = path.join(__dirname, "..", "..", "renderer-dist");
  installPackagedRendererCspReportOnlyHandler(
    session.defaultSession,
    rendererDistPath,
  );
};

const registerIpcHandlers = () => {
  handleTrusted("desktop:get-server-url", () => {
    return getServerUrl();
  });

  handleTrusted("desktop:get-window-controls-state", () => {
    return getWindowControlsState();
  });

  handleTrusted(
    "desktop:minimize-window",
    (event: IpcMainInvokeEvent): void => {
      const window = BrowserWindow.fromWebContents(event.sender);
      window?.minimize();
    },
  );

  handleTrusted(
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

  handleTrusted("desktop:close-window", (event: IpcMainInvokeEvent): void => {
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.close();
  });

  handleTrusted(
    "desktop:set-server-url",
    (_event: IpcMainInvokeEvent, serverUrl: string) => {
      return setServerUrl(serverUrl);
    },
    validateSetServerUrlArgs,
  );

  handleTrusted("desktop:get-capabilities", () => {
    return refreshDesktopCapabilities();
  });

  handleTrusted("desktop:get-system-idle-seconds", () => {
    return powerMonitor.getSystemIdleTime();
  });

  handleTrusted("desktop:get-video-encode-capabilities", () => {
    return resolveVideoEncodeCapabilities();
  });

  handleTrusted(
    "desktop:list-app-audio-targets",
    (_event, sourceId?: string) => {
      return captureSidecarManager.listAppAudioTargets(sourceId);
    },
    validateListAppAudioTargetsArgs,
  );

  handleTrusted(
    "desktop:start-app-audio-capture",
    (_event, input: TStartAppAudioCaptureInput) => {
      return captureSidecarManager.startAppAudioCapture({
        ...input,
        selfExcludePid: process.pid,
      });
    },
    validateStartAppAudioCaptureArgs,
  );

  handleTrusted(
    "desktop:stop-app-audio-capture",
    (_event, sessionId?: string) => {
      return captureSidecarManager.stopAppAudioCapture(sessionId);
    },
    validateStopAppAudioCaptureArgs,
  );

  handleTrusted(
    "desktop:set-global-push-keybinds",
    async (_event, input?: TDesktopPushKeybindsInput) => {
      return await setGlobalPushKeybinds(input);
    },
    validateSetGlobalPushKeybindsArgs,
  );

  onTrusted("desktop:open-app-audio-frame-channel", (event: IpcMainEvent) => {
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

  onTrusted(
    "desktop:before-quit-finished",
    (_event: IpcMainEvent, result: TDesktopQuitFlushResult) => {
      completeDesktopQuitFlush(result);
    },
    validateDesktopQuitFlushResultArgs,
  );

  handleTrusted("desktop:debug-request-before-quit-flush", async () => {
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

  handleTrusted("desktop:ping-sidecar", () => {
    return captureSidecarManager.getStatus();
  });

  handleTrusted("desktop:get-update-status", () => {
    return desktopUpdater.getStatus();
  });

  handleTrusted("desktop:check-for-updates", async () => {
    await desktopUpdater.checkForUpdates();
    return desktopUpdater.getStatus();
  });

  handleTrusted("desktop:list-share-sources", () => {
    return listShareSources();
  });

  handleTrusted(
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
    validatePrepareScreenShareArgs,
  );
};

// Surface whether Chromium is using hardware (NVENC/VAAPI/etc.) video encode.
// mediaCapabilities.encodingInfo({type:'webrtc'}) in the renderer reports
// powerEfficient:false for every codec when hardware encode is disabled, which
// silently pushes screen share onto software encoders. getGPUFeatureStatus is
// the authoritative source: video_encode === 'enabled' means hardware encode is
// available.
//
// Electron's main-process stdout is not attached to a console on Windows, so we
// also write the result to a fixed temp file the user can open directly.
const GPU_DIAGNOSTICS_FILENAME = "ripcord-gpu-diagnostics.json";

const logGpuEncodeDiagnostics = async () => {
  let featureStatus: unknown;
  try {
    featureStatus = app.getGPUFeatureStatus();
  } catch (error) {
    featureStatus = { error: String(error) };
  }

  let gpuInfo: unknown;
  try {
    gpuInfo = await app.getGPUInfo("basic");
  } catch (error) {
    gpuInfo = { error: String(error) };
  }

  let encodeCapabilities: unknown;
  try {
    encodeCapabilities = await resolveVideoEncodeCapabilities();
  } catch (error) {
    encodeCapabilities = { error: String(error) };
  }

  const diagnostics = {
    timestamp: new Date().toISOString(),
    featureStatus,
    encodeCapabilities,
    gpuInfo,
  };

  console.info("[desktop] GPU encode diagnostics", diagnostics);

  try {
    const filePath = path.join(app.getPath("temp"), GPU_DIAGNOSTICS_FILENAME);
    fs.writeFileSync(filePath, JSON.stringify(diagnostics, null, 2));
    console.info("[desktop] Wrote GPU diagnostics to", filePath);
  } catch (error) {
    console.warn("[desktop] Failed to write GPU diagnostics file", error);
  }
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
    setupPermissionHandlers();
    setupDisplayMediaHandler();
    setupYoutubeEmbedRefererHandler();
    setupPackagedRendererCspHandler();
    void logGpuEncodeDiagnostics();
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
