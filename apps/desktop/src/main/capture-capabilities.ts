import type { TSidecarCapabilities } from "./capture-sidecar-manager";
import type { TDesktopCapabilities } from "./types";

type TResolveCapabilityOptions = {
  baseCapabilities: TDesktopCapabilities;
  sidecarAvailable: boolean;
  sidecarReason?: string;
  sidecarPerAppAudioSupported?: boolean;
  sidecarCapabilities?: TSidecarCapabilities;
};

const appendNote = (notes: string[], note: string | undefined) => {
  if (!note) {
    return;
  }

  const trimmedNote = note.trim();
  if (!trimmedNote || notes.includes(trimmedNote)) {
    return;
  }

  notes.push(trimmedNote);
};

const formatSessionTypeLabel = (sessionType: string) => {
  if (sessionType === "x11") {
    return "X11";
  }

  if (sessionType === "wayland") {
    return "Wayland";
  }

  return sessionType;
};

const resolveDesktopCaptureCapabilities = ({
  baseCapabilities,
  sidecarAvailable,
  sidecarReason,
  sidecarPerAppAudioSupported = false,
  sidecarCapabilities,
}: TResolveCapabilityOptions): TDesktopCapabilities => {
  const notes = [...baseCapabilities.notes];

  if (baseCapabilities.platform === "linux") {
    if (sidecarCapabilities?.sessionType) {
      appendNote(
        notes,
        `Linux session type: ${formatSessionTypeLabel(sidecarCapabilities.sessionType)}.`,
      );
    }

    if (sidecarCapabilities?.pipewireToolsAvailable === false) {
      appendNote(
        notes,
        sidecarCapabilities.appAudioTargetEnumerationReason ??
          sidecarReason ??
          "PipeWire tools required for Linux app audio capture are unavailable.",
      );
    }

    if (sidecarCapabilities?.sourceAudioTargetInferenceSupported === false) {
      appendNote(
        notes,
        sidecarCapabilities.sourceAudioTargetInferenceReason ??
          "Linux does not infer the app audio target from the selected share source; choose a target manually.",
      );
    }

    if (!sidecarAvailable || !sidecarPerAppAudioSupported) {
      appendNote(
        notes,
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

    appendNote(
      notes,
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
      baseCapabilities.platform === "macos"
        ? `Screen audio capture unavailable: ${sidecarReason ?? "the Rust sidecar is not running."}`
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
