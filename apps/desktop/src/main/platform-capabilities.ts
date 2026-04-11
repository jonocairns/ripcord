import type {
  TDesktopCapabilities,
  TResolvedScreenAudioMode,
  TScreenAudioMode,
  TScreenShareSelection,
} from "./types";

const getDesktopCapabilitiesForPlatform = (
  platform: NodeJS.Platform,
): TDesktopCapabilities => {
  switch (platform) {
    case "win32":
      return {
        platform: "windows",
        systemAudio: "supported",
        perAppAudio: "supported",
        globalPushKeybinds: "supported",
        issues: [],
        notes: [],
      };
    case "darwin":
      return {
        platform: "macos",
        systemAudio: "supported",
        perAppAudio: "supported",
        globalPushKeybinds: "supported",
        issues: [],
        notes: [
          "macOS system and per-app audio capture use the Rust sidecar and ScreenCaptureKit.",
          "Grant Screen Recording permission in System Settings if macOS blocks capture startup.",
          "System mode excludes Ripcord audio when the sidecar capture path is active.",
        ],
      };
    case "linux":
    default:
      return {
        platform: "linux",
        systemAudio: "best-effort",
        perAppAudio: "best-effort",
        globalPushKeybinds: "best-effort",
        issues: [],
        notes: [
          "Linux audio capture depends on your compositor and PipeWire portal.",
        ],
      };
  }
};

const getDesktopCapabilities = (): TDesktopCapabilities => {
  return getDesktopCapabilitiesForPlatform(process.platform);
};

const resolveScreenAudioMode = (
  requestedMode: TScreenAudioMode,
  capabilities: TDesktopCapabilities,
): TResolvedScreenAudioMode => {
  if (requestedMode === "none") {
    return {
      requestedMode,
      effectiveMode: "none",
    };
  }

  if (requestedMode === "system") {
    if (capabilities.systemAudio === "unsupported") {
      return {
        requestedMode,
        effectiveMode: "none",
        warning:
          "System audio is not supported on this platform. Continuing without shared audio.",
      };
    }

    if (capabilities.systemAudio === "best-effort") {
      return {
        requestedMode,
        effectiveMode: "system",
        warning:
          "System audio capture is best-effort on this platform and may fail.",
      };
    }

    return {
      requestedMode,
      effectiveMode: "system",
    };
  }

  if (requestedMode === "app") {
    if (capabilities.perAppAudio === "unsupported") {
      if (capabilities.systemAudio !== "unsupported") {
        return {
          requestedMode,
          effectiveMode: "system",
          warning:
            "Per-app audio is not supported. Falling back to system audio.",
        };
      }

      return {
        requestedMode,
        effectiveMode: "none",
        warning:
          "Per-app audio is not supported on this platform. Continuing without shared audio.",
      };
    }

    if (capabilities.perAppAudio === "best-effort") {
      return {
        requestedMode,
        effectiveMode: "app",
        warning:
          "Per-app audio capture is best-effort on this platform and may fail.",
      };
    }

    return {
      requestedMode,
      effectiveMode: "app",
    };
  }

  return {
    requestedMode,
    effectiveMode: "none",
  };
};

const resolvePreparedScreenAudioMode = (
  selection: TScreenShareSelection,
  capabilities: TDesktopCapabilities,
): TResolvedScreenAudioMode => {
  if (
    selection.audioMode === "app" &&
    selection.sourceId.startsWith("screen:")
  ) {
    const fallbackMode =
      capabilities.systemAudio === "unsupported" ? "none" : "system";

    return {
      requestedMode: selection.audioMode,
      effectiveMode: fallbackMode,
      warning:
        fallbackMode === "none"
          ? "Per-app audio is not available when sharing an entire display. Continuing without shared audio."
          : "Per-app audio is not available when sharing an entire display. Falling back to system audio.",
    };
  }

  const resolved = resolveScreenAudioMode(selection.audioMode, capabilities);
  const requiresExplicitAppTarget =
    resolved.effectiveMode === "app" &&
    !selection.appAudioTargetId &&
    capabilities.platform === "linux";

  if (!requiresExplicitAppTarget) {
    return resolved;
  }

  const fallbackMode =
    capabilities.systemAudio === "unsupported" ? "none" : "system";
  const warningPrefix =
    "Per-app audio on Linux requires choosing a running app audio target.";

  return {
    requestedMode: selection.audioMode,
    effectiveMode: fallbackMode,
    warning:
      fallbackMode === "none"
        ? `${warningPrefix} Continuing without shared audio.`
        : `${warningPrefix} Falling back to system audio.`,
  };
};

export {
  getDesktopCapabilities,
  getDesktopCapabilitiesForPlatform,
  resolvePreparedScreenAudioMode,
  resolveScreenAudioMode,
};
