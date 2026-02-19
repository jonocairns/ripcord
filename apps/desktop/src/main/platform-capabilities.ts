import type {
  TDesktopCapabilities,
  TResolvedScreenAudioMode,
  TScreenAudioMode,
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
        notes: [],
      };
    case "darwin":
      return {
        platform: "macos",
        systemAudio: "unsupported",
        perAppAudio: "unsupported",
        notes: [
          "macOS blocks system and per-app screen-share audio in this preview.",
        ],
      };
    case "linux":
    default:
      return {
        platform: "linux",
        systemAudio: "best-effort",
        perAppAudio: "best-effort",
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

export {
  getDesktopCapabilities,
  getDesktopCapabilitiesForPlatform,
  resolveScreenAudioMode,
};
