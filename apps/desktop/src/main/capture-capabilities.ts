import type { TSidecarCapabilities } from "./capture-sidecar-manager";
import type {
  TDesktopCapabilities,
  TDesktopCapabilityIssue,
  TSupportLevel,
} from "./types";

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

const appendIssue = (
  issues: TDesktopCapabilityIssue[],
  issue: TDesktopCapabilityIssue | undefined,
) => {
  if (!issue) {
    return;
  }

  const exists = issues.some((existingIssue) => {
    return (
      existingIssue.code === issue.code &&
      existingIssue.message === issue.message &&
      existingIssue.affects.length === issue.affects.length &&
      existingIssue.affects.every((feature, index) => {
        return feature === issue.affects[index];
      })
    );
  });

  if (!exists) {
    issues.push(issue);
  }
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

const createCapabilityIssue = ({
  code,
  affects,
  severity,
  title,
  message,
  guidance,
}: TDesktopCapabilityIssue): TDesktopCapabilityIssue => {
  return {
    code,
    affects,
    severity,
    title,
    message,
    guidance,
  };
};

const createIssueFromCode = (
  code: string | undefined,
  message: string,
): TDesktopCapabilityIssue => {
  switch (code) {
    case "linux-pipewire-tools-missing":
      return createCapabilityIssue({
        code,
        affects: ["per-app-audio"],
        severity: "error",
        title: "PipeWire tools unavailable",
        message,
        guidance: [
          "Install the missing PipeWire tools, then reopen the screen-share picker.",
          "Use system audio or no shared audio until PipeWire is available.",
        ],
      });
    case "linux-manual-app-target-selection-required":
      return createCapabilityIssue({
        code,
        affects: ["per-app-audio"],
        severity: "info",
        title: "Manual app selection required",
        message,
        guidance: [
          "Choose the running application that is producing sound before starting screen share.",
        ],
      });
    case "linux-x11-display-required":
      return createCapabilityIssue({
        code,
        affects: ["global-push-keybinds"],
        severity: "error",
        title: "Global push keybinds unavailable",
        message,
        guidance: [
          "Use an X11 or XWayland session for global push-to-talk and push-to-mute.",
        ],
      });
    case "linux-xwayland-best-effort":
      return createCapabilityIssue({
        code,
        affects: ["global-push-keybinds"],
        severity: "warning",
        title: "Global push keybinds may be unreliable",
        message,
        guidance: [
          "Wayland global keybinds currently depend on XWayland support in the active compositor.",
        ],
      });
    case "macos-helper-unavailable":
      return createCapabilityIssue({
        code,
        affects: ["system-audio", "per-app-audio"],
        severity: "error",
        title: "macOS capture helper unavailable",
        message,
        guidance: [
          "Reinstall or rebuild the desktop app so the macOS audio helper is bundled correctly.",
        ],
      });
    case "macos-version-unsupported":
      return createCapabilityIssue({
        code,
        affects: ["system-audio", "per-app-audio"],
        severity: "error",
        title: "macOS version unsupported for screen audio",
        message,
        guidance: ["Use macOS 13 or newer for ScreenCaptureKit audio capture."],
      });
    case "macos-screen-recording-permission-required":
      return createCapabilityIssue({
        code,
        affects: ["system-audio", "per-app-audio"],
        severity: "error",
        title: "Screen Recording permission required",
        message,
        guidance: [
          "Grant Sharkord Screen Recording access in System Settings, then try screen sharing again.",
        ],
      });
    case "macos-screen-audio-unavailable":
      return createCapabilityIssue({
        code,
        affects: ["system-audio", "per-app-audio"],
        severity: "error",
        title: "macOS screen audio unavailable",
        message,
        guidance: [
          "Check Screen Recording permission and try again.",
          "If the issue persists, reinstall the desktop app to restore the audio helper.",
        ],
      });
    case "desktop-sidecar-unavailable":
    default:
      return createCapabilityIssue({
        code: code ?? "desktop-sidecar-unavailable",
        affects: ["system-audio", "per-app-audio"],
        severity: "error",
        title: "Desktop audio sidecar unavailable",
        message,
        guidance: [
          "Restart Sharkord and retry screen sharing.",
          "If the sidecar binary is missing, reinstall the desktop app.",
        ],
      });
  }
};

const resolveGlobalPushKeybinds = (
  baseCapabilities: TDesktopCapabilities,
  sidecarCapabilities?: TSidecarCapabilities,
): TSupportLevel => {
  return (
    sidecarCapabilities?.globalPushKeybinds ??
    baseCapabilities.globalPushKeybinds
  );
};

const resolveDesktopCaptureCapabilities = ({
  baseCapabilities,
  sidecarAvailable,
  sidecarReason,
  sidecarPerAppAudioSupported = false,
  sidecarCapabilities,
}: TResolveCapabilityOptions): TDesktopCapabilities => {
  const notes = [...baseCapabilities.notes];
  const issues = [...baseCapabilities.issues];
  const globalPushKeybinds = resolveGlobalPushKeybinds(
    baseCapabilities,
    sidecarCapabilities,
  );

  if (baseCapabilities.platform === "linux") {
    if (sidecarCapabilities?.sessionType) {
      appendNote(
        notes,
        `Linux session type: ${formatSessionTypeLabel(sidecarCapabilities.sessionType)}.`,
      );
    }

    appendIssue(
      issues,
      sidecarCapabilities?.appAudioTargetEnumerationSupported === false
        ? createIssueFromCode(
            sidecarCapabilities.appAudioTargetEnumerationReasonCode ??
              "linux-pipewire-tools-missing",
            sidecarCapabilities.appAudioTargetEnumerationReason ??
              sidecarCapabilities.perAppAudioReason ??
              sidecarReason ??
              "PipeWire tools required for Linux app audio capture are unavailable.",
          )
        : undefined,
    );

    appendIssue(
      issues,
      sidecarCapabilities?.sourceAudioTargetInferenceSupported === false
        ? createIssueFromCode(
            sidecarCapabilities.sourceAudioTargetInferenceReasonCode ??
              "linux-manual-app-target-selection-required",
            sidecarCapabilities.sourceAudioTargetInferenceReason ??
              "Linux does not infer the app audio target from the selected share source; choose a target manually.",
          )
        : undefined,
    );

    appendIssue(
      issues,
      sidecarCapabilities?.globalPushKeybindsReason
        ? createIssueFromCode(
            sidecarCapabilities.globalPushKeybindsReasonCode,
            sidecarCapabilities.globalPushKeybindsReason,
          )
        : undefined,
    );

    if (!sidecarAvailable || !sidecarPerAppAudioSupported) {
      appendIssue(
        issues,
        createIssueFromCode(
          sidecarCapabilities?.perAppAudioReasonCode ??
            sidecarCapabilities?.appAudioTargetEnumerationReasonCode,
          sidecarCapabilities?.perAppAudioReason ??
            sidecarCapabilities?.appAudioTargetEnumerationReason ??
            (sidecarReason
              ? `Per-app audio capture unavailable: ${sidecarReason}`
              : "Per-app audio capture unavailable because the Rust sidecar is not running."),
        ),
      );

      return {
        ...baseCapabilities,
        perAppAudio: "unsupported",
        globalPushKeybinds,
        sidecarAvailable,
        issues,
        notes,
      };
    }

    appendNote(
      notes,
      "Linux sidecar audio uses PipeWire. Per-app capture may require selecting the emitting application manually, and system mode excludes Sharkord audio on a best-effort basis.",
    );

    return {
      ...baseCapabilities,
      globalPushKeybinds,
      sidecarAvailable: true,
      issues,
      notes,
    };
  }

  if (!sidecarAvailable || !sidecarPerAppAudioSupported) {
    const unavailableMessage =
      baseCapabilities.platform === "macos"
        ? `Screen audio capture unavailable: ${sidecarReason ?? "the Rust sidecar is not running."}`
        : sidecarReason
          ? `Per-app audio capture unavailable: ${sidecarReason}`
          : "Per-app audio capture unavailable because the Rust sidecar is not running.";

    appendIssue(
      issues,
      createIssueFromCode(
        sidecarCapabilities?.reasonCode ??
          (baseCapabilities.platform === "macos"
            ? "macos-screen-audio-unavailable"
            : "desktop-sidecar-unavailable"),
        unavailableMessage,
      ),
    );

    return {
      ...baseCapabilities,
      systemAudio:
        baseCapabilities.platform === "macos"
          ? "unsupported"
          : baseCapabilities.systemAudio,
      perAppAudio: "unsupported",
      globalPushKeybinds,
      sidecarAvailable: false,
      issues,
      notes,
    };
  }

  return {
    ...baseCapabilities,
    perAppAudio: "supported",
    globalPushKeybinds,
    sidecarAvailable: true,
    issues,
    notes,
  };
};

export { resolveDesktopCaptureCapabilities };
