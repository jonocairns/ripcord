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
    assert.match(resolved.notes.join(" "), /binary not found/);
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
      },
    });

    assert.equal(resolved.systemAudio, "best-effort");
    assert.equal(resolved.perAppAudio, "unsupported");
    assert.equal(resolved.sidecarAvailable, true);
    assert.match(resolved.notes.join(" "), /pw-record is not installed/i);
    assert.match(resolved.notes.join(" "), /session type: X11/i);
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
    assert.match(resolved.notes.join(" "), /PipeWire/i);
    assert.match(resolved.notes.join(" "), /session type: Wayland/i);
    assert.match(resolved.notes.join(" "), /choose a target manually/i);
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
    assert.match(resolved.notes.join(" "), /helper missing/i);
  });
});
