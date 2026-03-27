import type { TDesktopCapabilities } from "./types";

type TResolveCapabilityOptions = {
  baseCapabilities: TDesktopCapabilities;
  sidecarAvailable: boolean;
  sidecarReason?: string;
  sidecarPerAppAudioSupported?: boolean;
};

const resolveDesktopCaptureCapabilities = ({
  baseCapabilities,
  sidecarAvailable,
  sidecarReason,
  sidecarPerAppAudioSupported = false,
}: TResolveCapabilityOptions): TDesktopCapabilities => {
  const notes = [...baseCapabilities.notes];

  if (baseCapabilities.platform === "macos") {
    return {
      ...baseCapabilities,
      sidecarAvailable,
      notes,
    };
  }

  if (baseCapabilities.platform === "linux") {
    if (!sidecarAvailable || !sidecarPerAppAudioSupported) {
      notes.push(
        sidecarReason
          ? `Per-app audio capture unavailable: ${sidecarReason}`
          : "Per-app audio capture unavailable because the Rust sidecar is not running.",
      );

      return {
        ...baseCapabilities,
        perAppAudio: "unsupported",
        sidecarAvailable,
        notes,
      };
    }

    notes.push(
      "Linux sidecar audio uses PipeWire. Per-app capture may require selecting the emitting application manually, and system mode excludes Sharkord audio on a best-effort basis.",
    );

    return {
      ...baseCapabilities,
      sidecarAvailable: true,
      notes,
    };
  }

  if (!sidecarAvailable || !sidecarPerAppAudioSupported) {
    notes.push(
      sidecarReason
        ? `Per-app audio capture unavailable: ${sidecarReason}`
        : "Per-app audio capture unavailable because the Rust sidecar is not running.",
    );

    return {
      ...baseCapabilities,
      perAppAudio: "unsupported",
      sidecarAvailable: false,
      notes,
    };
  }

  return {
    ...baseCapabilities,
    perAppAudio: "supported",
    sidecarAvailable: true,
    notes,
  };
};

export { resolveDesktopCaptureCapabilities };
