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

  if (baseCapabilities.platform !== "windows") {
    return {
      ...baseCapabilities,
      sidecarAvailable,
      notes,
    };
  }

  if (!sidecarAvailable) {
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
