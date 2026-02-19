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

  void it("downgrades per-app audio when experimental toggle is off", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("win32");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      experimentalRustCapture: false,
    });

    assert.equal(resolved.perAppAudio, "unsupported");
    assert.equal(resolved.sidecarAvailable, true);
    assert.match(resolved.notes.join(" "), /disabled/);
  });

  void it("keeps per-app audio enabled when sidecar is available", () => {
    const baseCapabilities = getDesktopCapabilitiesForPlatform("win32");

    const resolved = resolveDesktopCaptureCapabilities({
      baseCapabilities,
      sidecarAvailable: true,
      experimentalRustCapture: true,
    });

    assert.equal(resolved.perAppAudio, "supported");
    assert.equal(resolved.sidecarAvailable, true);
  });
});
