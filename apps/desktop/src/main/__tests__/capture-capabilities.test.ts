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

  void it("downgrades linux per-app audio when the sidecar path is unavailable", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("linux");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      sidecarPerAppAudioSupported: false,
      sidecarReason: "pw-record is not installed",
      sidecarCapabilities: {
        sessionType: "x11",
        pipewireToolsAvailable: false,
        appAudioTargetEnumerationSupported: false,
        appAudioTargetEnumerationReason: "pw-record is not installed",
        sourceAudioTargetInferenceSupported: false,
      },
    });

    assert.equal(resolved.systemAudio, "best-effort");
    assert.equal(resolved.perAppAudio, "unsupported");
    assert.equal(resolved.sidecarAvailable, true);
    assert.equal(resolved.issues[0]?.code, "linux-pipewire-tools-missing");
    assert.match(
      resolved.issues[0]?.message ?? "",
      /pw-record is not installed/i,
    );
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
        pipewireToolsAvailable: true,
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
    assert.match(resolved.notes.join(" "), /PipeWire/i);
    assert.match(resolved.notes.join(" "), /session type: Wayland/i);
  });

  void it("surfaces linux global push keybind requirements as structured issues", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("linux");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      sidecarPerAppAudioSupported: true,
      sidecarCapabilities: {
        sessionType: "wayland",
        pipewireToolsAvailable: true,
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
});
