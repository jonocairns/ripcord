import {
  app,
  BrowserWindow,
  globalShortcut,
  type IpcMainEvent,
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
import type {
  TDesktopPushKeybindEvent,
  TDesktopPushKeybindsInput,
  TGlobalPushKeybindRegistrationResult,
  TPushKeybindKind,
  TScreenShareSelection,
  TStartAppAudioCaptureInput,
  TStartVoiceFilterInput,
  TVoiceFilterFrame,
} from "./types";

const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
let mainWindow: BrowserWindow | null = null;
const PUSH_KEYBIND_RELEASE_TIMEOUT_MS = 400;

if (process.platform === "linux") {
  // Required on Wayland compositors for globalShortcut to work while unfocused.
  app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
}

type TPushShortcutState = {
  accelerator: string;
  active: boolean;
  releaseTimer?: ReturnType<typeof setTimeout>;
};

const pushShortcutStates: Record<TPushKeybindKind, TPushShortcutState | undefined> = {
  talk: undefined,
  mute: undefined,
};

const emitPushKeybindEvent = (event: TDesktopPushKeybindEvent) => {
  mainWindow?.webContents.send("desktop:global-push-keybind", event);
};

const mapKeyCodeToAccelerator = (keyCode: string): string | undefined => {
  if (keyCode.startsWith("Key") && keyCode.length === 4) {
    return keyCode.slice(3).toUpperCase();
  }

  if (keyCode.startsWith("Digit") && keyCode.length === 6) {
    return keyCode.slice(5);
  }

  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(keyCode)) {
    return keyCode;
  }

  if (keyCode.startsWith("Numpad") && keyCode.length === 7) {
    return `num${keyCode.slice(6)}`;
  }

  switch (keyCode) {
    case "Space":
      return "Space";
    case "Enter":
      return "Enter";
    case "Escape":
      return "Esc";
    case "Backspace":
      return "Backspace";
    case "Tab":
      return "Tab";
    case "CapsLock":
      return "Capslock";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "Delete":
      return "Delete";
    case "Insert":
      return "Insert";
    case "Home":
      return "Home";
    case "End":
      return "End";
    case "PageUp":
      return "PageUp";
    case "PageDown":
      return "PageDown";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Backslash":
      return "\\";
    case "Semicolon":
      return ";";
    case "Quote":
      return "'";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Slash":
      return "/";
    case "Backquote":
      return "`";
    case "NumpadMultiply":
      return "nummult";
    case "NumpadAdd":
      return "numadd";
    case "NumpadSubtract":
      return "numsub";
    case "NumpadDecimal":
      return "numdec";
    case "NumpadDivide":
      return "numdiv";
    case "NumpadEnter":
      return "numenter";
    default:
      return undefined;
  }
};

const getRestrictedAcceleratorReason = (
  modifiers: Set<string>,
  key: string,
): string | undefined => {
  if (process.platform !== "win32") {
    return undefined;
  }

  if (modifiers.has("Super")) {
    return "Windows-key combinations are reserved by the operating system.";
  }

  if (modifiers.has("Alt") && key === "Tab") {
    return "Alt+Tab is reserved by the operating system.";
  }

  if (modifiers.has("Alt") && key === "Esc") {
    return "Alt+Esc is reserved by the operating system.";
  }

  if (modifiers.has("Control") && modifiers.has("Alt") && key === "Delete") {
    return "Ctrl+Alt+Delete is reserved by the operating system.";
  }

  if (modifiers.has("Control") && modifiers.has("Shift") && key === "Esc") {
    return "Ctrl+Shift+Esc is reserved by the operating system.";
  }

  return undefined;
};

const parsePushKeybindToAccelerator = (
  keybind?: string,
): { accelerator?: string; error?: string } => {
  if (!keybind || typeof keybind !== "string") {
    return {};
  }

  const tokens = keybind
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return {};
  }

  const modifiers = new Set<string>();
  let keyCode = "";

  for (const token of tokens) {
    if (token === "Control") {
      modifiers.add("Control");
      continue;
    }

    if (token === "Alt") {
      modifiers.add("Alt");
      continue;
    }

    if (token === "Shift") {
      modifiers.add("Shift");
      continue;
    }

    if (token === "Meta") {
      modifiers.add("Super");
      continue;
    }

    if (keyCode) {
      return {
        error: "Invalid keybind format.",
      };
    }

    keyCode = token;
  }

  if (!keyCode) {
    return {
      error: "Missing key code in keybind.",
    };
  }

  const key = mapKeyCodeToAccelerator(keyCode);

  if (!key) {
    return {
      error: "Unsupported key for global shortcuts.",
    };
  }

  const restrictedReason = getRestrictedAcceleratorReason(modifiers, key);

  if (restrictedReason) {
    return {
      error: restrictedReason,
    };
  }

  return {
    accelerator: [...modifiers, key].join("+"),
  };
};

const clearPushShortcutState = (
  kind: TPushKeybindKind,
  options?: { emitInactive?: boolean },
) => {
  const state = pushShortcutStates[kind];

  if (!state) {
    return;
  }

  if (state.releaseTimer) {
    clearTimeout(state.releaseTimer);
  }

  if (globalShortcut.isRegistered(state.accelerator)) {
    globalShortcut.unregister(state.accelerator);
  }

  if (state.active && options?.emitInactive !== false) {
    emitPushKeybindEvent({
      kind,
      active: false,
    });
  }

  pushShortcutStates[kind] = undefined;
};

const clearPushShortcutStates = () => {
  clearPushShortcutState("talk");
  clearPushShortcutState("mute");
};

const activatePushShortcut = (kind: TPushKeybindKind) => {
  const state = pushShortcutStates[kind];

  if (!state) {
    return;
  }

  if (!state.active) {
    state.active = true;

    emitPushKeybindEvent({
      kind,
      active: true,
    });
  }

  if (state.releaseTimer) {
    clearTimeout(state.releaseTimer);
  }

  state.releaseTimer = setTimeout(() => {
    const currentState = pushShortcutStates[kind];

    if (!currentState || !currentState.active) {
      return;
    }

    currentState.active = false;
    currentState.releaseTimer = undefined;

    emitPushKeybindEvent({
      kind,
      active: false,
    });
  }, PUSH_KEYBIND_RELEASE_TIMEOUT_MS);
};

const registerPushShortcut = (
  kind: TPushKeybindKind,
  accelerator?: string,
): boolean => {
  if (!accelerator) {
    return false;
  }

  const registered = globalShortcut.register(accelerator, () => {
    if (mainWindow?.isFocused()) {
      return;
    }

    activatePushShortcut(kind);
  });

  if (!registered) {
    console.warn("[desktop] Failed to register push keybind shortcut", {
      kind,
      accelerator,
    });
    return false;
  }

  pushShortcutStates[kind] = {
    accelerator,
    active: false,
  };

  return true;
};

const setGlobalPushKeybinds = (
  input?: TDesktopPushKeybindsInput,
): TGlobalPushKeybindRegistrationResult => {
  clearPushShortcutStates();
  const errors: string[] = [];

  const {
    accelerator: talkAccelerator,
    error: talkParseError,
  } = parsePushKeybindToAccelerator(
    input?.pushToTalkKeybind,
  );
  const {
    accelerator: muteAccelerator,
    error: muteParseError,
  } = parsePushKeybindToAccelerator(
    input?.pushToMuteKeybind,
  );

  if (input?.pushToTalkKeybind && talkParseError) {
    errors.push(`Push-to-talk keybind is invalid: ${talkParseError}`);
  }

  const talkRegistered = registerPushShortcut("talk", talkAccelerator);

  if (muteAccelerator && muteAccelerator === talkAccelerator) {
    errors.push(
      "Push-to-mute keybind matches push-to-talk and was ignored.",
    );
    return {
      talkRegistered,
      muteRegistered: false,
      talkAccelerator,
      muteAccelerator: undefined,
      errors,
    };
  }

  if (input?.pushToMuteKeybind && muteParseError) {
    errors.push(`Push-to-mute keybind is invalid: ${muteParseError}`);
  }

  const muteRegistered = registerPushShortcut("mute", muteAccelerator);

  if (input?.pushToTalkKeybind && talkAccelerator && !talkRegistered) {
    errors.push(
      "Push-to-talk keybind could not be registered. It may be reserved by Windows or another app.",
    );
  }

  if (input?.pushToMuteKeybind && muteAccelerator && !muteRegistered) {
    errors.push(
      "Push-to-mute keybind could not be registered. It may be reserved by Windows or another app.",
    );
  }

  return {
    talkRegistered,
    muteRegistered,
    talkAccelerator,
    muteAccelerator,
    errors,
  };
};

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
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#090d12",
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
    (_event, input?: TDesktopPushKeybindsInput) => {
      return setGlobalPushKeybinds(input);
    },
  );

  ipcMain.on(
    "desktop:push-voice-filter-frame",
    (_event: IpcMainEvent, frame: TVoiceFilterFrame) => {
      captureSidecarManager.pushVoiceFilterFrame(frame);
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
    captureSidecarManager.onVoiceFilterFrame((frame) => {
      mainWindow?.webContents.send("desktop:voice-filter-frame", frame);
    });
    captureSidecarManager.onVoiceFilterStatus((event) => {
      mainWindow?.webContents.send("desktop:voice-filter-status", event);
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
  clearPushShortcutStates();
  void captureSidecarManager.dispose();
});
