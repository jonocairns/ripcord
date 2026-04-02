import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDesktopCaptureCapabilities } from "../capture-capabilities";
import { getDesktopCapabilitiesForPlatform } from "../platform-capabilities";

void describe("resolveDesktopCaptureCapabilities", () => {
  void it("downgrades per-app audio when sidecar is unavailable", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("win32");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: false,
      sidecarReason: "binary not found",
    });

    assert.equal(resolved.perAppAudio, "unsupported");
    assert.equal(resolved.sidecarAvailable, false);
    assert.equal(resolved.issues[0]?.code, "desktop-sidecar-unavailable");
    assert.match(resolved.issues[0]?.message ?? "", /binary not found/i);
  });

  void it("keeps per-app audio enabled when sidecar is available", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("win32");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      sidecarPerAppAudioSupported: true,
    });

    assert.equal(resolved.perAppAudio, "supported");
    assert.equal(resolved.sidecarAvailable, true);
  });

  void it("downgrades linux system and per-app audio when the native backend is unavailable", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("linux");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      sidecarPerAppAudioSupported: false,
      sidecarReason: "Failed to connect to the Linux audio server.",
      sidecarCapabilities: {
        systemAudio: "unsupported",
        sessionType: "x11",
        linuxAudioBackend: "pulseaudio-native",
        linuxAudioBackendUsesShellOuts: false,
        linuxAudioRuntimeAvailable: true,
        linuxAudioCaptureAvailable: false,
        appAudioTargetEnumerationSupported: false,
        appAudioTargetEnumerationReason:
          "Failed to connect to the Linux audio server.",
        appAudioTargetEnumerationReasonCode:
          "linux-native-audio-backend-unavailable",
        sourceAudioTargetInferenceSupported: false,
      },
    });

    assert.equal(resolved.systemAudio, "unsupported");
    assert.equal(resolved.perAppAudio, "unsupported");
    assert.equal(resolved.sidecarAvailable, true);
    assert.equal(
      resolved.issues[0]?.code,
      "linux-native-audio-backend-unavailable",
    );
    assert.match(resolved.issues[0]?.message ?? "", /linux audio server/i);
    assert.match(resolved.notes.join(" "), /session type: X11/i);
    assert.equal(resolved.globalPushKeybinds, "best-effort");
  });

  void it("keeps linux per-app audio available when the sidecar path is ready", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("linux");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      sidecarPerAppAudioSupported: true,
      sidecarCapabilities: {
        sessionType: "wayland",
        linuxAudioBackend: "pulseaudio-native",
        linuxAudioBackendUsesShellOuts: false,
        linuxAudioRuntimeAvailable: true,
        linuxAudioCaptureAvailable: true,
        appAudioTargetEnumerationSupported: true,
        sourceAudioTargetInferenceSupported: false,
      },
    });

    assert.equal(resolved.systemAudio, "best-effort");
    assert.equal(resolved.perAppAudio, "best-effort");
    assert.equal(resolved.sidecarAvailable, true);
    assert.equal(resolved.globalPushKeybinds, "best-effort");
    assert.equal(
      resolved.issues.find(
        (issue) => issue.code === "linux-manual-app-target-selection-required",
      )?.title,
      "Manual app selection required",
    );
    assert.match(resolved.notes.join(" "), /pulseaudio-native/i);
    assert.match(resolved.notes.join(" "), /native PulseAudio-compatible/i);
    assert.match(resolved.notes.join(" "), /session type: Wayland/i);
  });

  void it("downgrades linux audio when capture startup is unavailable despite successful target probing", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("linux");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      sidecarPerAppAudioSupported: true,
      sidecarReason: "Failed to start Linux audio capture.",
      sidecarCapabilities: {
        systemAudio: "best-effort",
        sessionType: "x11",
        linuxAudioBackend: "pulseaudio-native",
        linuxAudioBackendUsesShellOuts: false,
        linuxAudioRuntimeAvailable: true,
        linuxAudioCaptureAvailable: false,
        perAppAudioReason: "Failed to start Linux audio capture.",
        perAppAudioReasonCode: "linux-native-audio-backend-unavailable",
        appAudioTargetEnumerationSupported: true,
        sourceAudioTargetInferenceSupported: false,
      },
    });

    assert.equal(resolved.systemAudio, "unsupported");
    assert.equal(resolved.perAppAudio, "unsupported");
    assert.equal(
      resolved.issues.find(
        (issue) => issue.code === "linux-native-audio-backend-unavailable",
      )?.message,
      "Failed to start Linux audio capture.",
    );
  });

  void it("surfaces linux global push keybind requirements as structured issues", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("linux");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      sidecarPerAppAudioSupported: true,
      sidecarCapabilities: {
        sessionType: "wayland",
        linuxAudioCaptureAvailable: true,
        appAudioTargetEnumerationSupported: true,
        sourceAudioTargetInferenceSupported: false,
        globalPushKeybinds: "unsupported",
        globalPushKeybindsReason:
          "Global push keybinds require an X11 display server connection.",
        globalPushKeybindsReasonCode: "linux-x11-display-required",
        x11DisplayAvailable: false,
        x11DisplayReason:
          "Global push keybinds require an X11 display server connection.",
        x11DisplayReasonCode: "linux-x11-display-required",
      },
    });

    assert.equal(resolved.globalPushKeybinds, "unsupported");
    assert.equal(
      resolved.issues.find(
        (issue) => issue.code === "linux-x11-display-required",
      )?.title,
      "Global push keybinds unavailable",
    );
  });

  void it("treats a configured Wayland shortcut portal as real support", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("linux");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      sidecarPerAppAudioSupported: true,
      sidecarCapabilities: {
        sessionType: "wayland",
        linuxAudioCaptureAvailable: true,
        appAudioTargetEnumerationSupported: true,
        sourceAudioTargetInferenceSupported: false,
        globalPushKeybinds: "supported",
        x11DisplayAvailable: false,
        x11DisplayReason:
          "No X11 display was detected for the current Linux session.",
        x11DisplayReasonCode: "linux-x11-display-required",
        linuxGlobalShortcutsPortalConfigured: true,
        linuxGlobalShortcutsPortalBackend: "gnome",
      },
    });

    assert.equal(resolved.globalPushKeybinds, "supported");
    assert.equal(
      resolved.issues.some(
        (issue) =>
          issue.code === "linux-wayland-global-shortcuts-portal-available",
      ),
      false,
    );
    assert.match(
      resolved.notes.join(" "),
      /Global Shortcuts portal backend: gnome/i,
    );
  });

  void it("surfaces a Linux desktop portal issue for Wayland screen sharing", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("linux");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      sidecarPerAppAudioSupported: true,
      sidecarCapabilities: {
        sessionType: "wayland",
        linuxAudioCaptureAvailable: true,
        portalAvailable: false,
        portalReason:
          "xdg-desktop-portal is not running for the current desktop session. Wayland screen sharing requires it.",
        portalReasonCode: "linux-desktop-portal-required",
        appAudioTargetEnumerationSupported: true,
        sourceAudioTargetInferenceSupported: false,
      },
    });

    assert.equal(
      resolved.issues.find(
        (issue) => issue.code === "linux-desktop-portal-required",
      )?.title,
      "Desktop portal unavailable",
    );
    assert.equal(
      resolved.issues
        .find((issue) => issue.code === "linux-desktop-portal-required")
        ?.affects.includes("screen-share"),
      true,
    );
  });

  void it("keeps legacy Linux audio tooling failures mapped for older sidecar contracts", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("linux");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      sidecarPerAppAudioSupported: false,
      sidecarCapabilities: {
        appAudioTargetEnumerationSupported: false,
        pipewireToolsAvailable: false,
      },
    });

    assert.equal(
      resolved.issues.find(
        (issue) => issue.code === "linux-pipewire-tools-missing",
      )?.title,
      "Linux audio tooling unavailable",
    );
  });

  void it("deduplicates linux backend issues when multiple reasons map to the same code", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("linux");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      sidecarPerAppAudioSupported: false,
      sidecarCapabilities: {
        systemAudio: "unsupported",
        sessionType: "x11",
        linuxAudioCaptureAvailable: false,
        perAppAudioReason:
          "Per-app capture stays disabled until the native Linux audio backend is ready.",
        perAppAudioReasonCode: "linux-native-audio-backend-unavailable",
        appAudioTargetEnumerationSupported: false,
        appAudioTargetEnumerationReason:
          "The native Linux audio backend is unavailable and app targets cannot be listed.",
        appAudioTargetEnumerationReasonCode:
          "linux-native-audio-backend-unavailable",
        sourceAudioTargetInferenceSupported: false,
      },
    });

    assert.equal(
      resolved.issues.filter(
        (issue) => issue.code === "linux-native-audio-backend-unavailable",
      ).length,
      1,
    );
  });

  void it("downgrades macOS per-app audio when the sidecar is unavailable", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("darwin");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: false,
      sidecarReason: "macOS helper missing",
    });

    assert.equal(resolved.systemAudio, "unsupported");
    assert.equal(resolved.perAppAudio, "unsupported");
    assert.equal(resolved.sidecarAvailable, false);
    assert.equal(resolved.issues[0]?.code, "macos-screen-audio-unavailable");
    assert.match(resolved.issues[0]?.message ?? "", /helper missing/i);
  });

  void it("surfaces macOS Screen Recording permission failures as a distinct issue", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("darwin");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: false,
      sidecarReason: "Grant Screen Recording access in System Settings.",
      sidecarCapabilities: {
        reasonCode: "macos-screen-recording-permission-required",
      },
    });

    assert.equal(resolved.systemAudio, "unsupported");
    assert.equal(resolved.perAppAudio, "unsupported");
    assert.equal(
      resolved.issues[0]?.code,
      "macos-screen-recording-permission-required",
    );
    assert.equal(
      resolved.issues[0]?.title,
      "Screen Recording permission required",
    );
  });

  void it("surfaces macOS version support failures as a distinct issue", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("darwin");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: false,
      sidecarReason:
        "ScreenCaptureKit audio capture requires macOS 13 or newer.",
      sidecarCapabilities: {
        reasonCode: "macos-version-unsupported",
      },
    });

    assert.equal(resolved.systemAudio, "unsupported");
    assert.equal(resolved.perAppAudio, "unsupported");
    assert.equal(resolved.issues[0]?.code, "macos-version-unsupported");
    assert.equal(
      resolved.issues[0]?.title,
      "macOS version unsupported for screen audio",
    );
  });
});
