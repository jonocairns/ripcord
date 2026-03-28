import type { TDesktopCapabilities } from "./types";

type TResolveCapabilityOptions = {
  baseCapabilities: TDesktopCapabilities;
  sidecarAvailable: boolean;
  sidecarReason?: string;
};

const resolveDesktopCaptureCapabilities = ({
  baseCapabilities,
  sidecarAvailable,
  sidecarReason,
}: TResolveCapabilityOptions): TDesktopCapabilities => {
  const notes = [...baseCapabilities.notes];

  if (
    baseCapabilities.platform !== "windows" &&
    baseCapabilities.platform !== "macos"
  ) {
    return {
      ...baseCapabilities,
      sidecarAvailable,
      notes,
    };
  }

  if (!sidecarAvailable) {
    const unavailableReason = sidecarReason
      ? sidecarReason
      : "the Rust sidecar is not running.";
    notes.push(
      baseCapabilities.platform === "macos"
        ? `Screen audio capture unavailable: ${unavailableReason}`
        : sidecarReason
          ? `Per-app audio capture unavailable: ${sidecarReason}`
          : "Per-app audio capture unavailable because the Rust sidecar is not running.",
    );

    return {
      ...baseCapabilities,
      systemAudio:
        baseCapabilities.platform === "macos"
          ? "unsupported"
          : baseCapabilities.systemAudio,
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
