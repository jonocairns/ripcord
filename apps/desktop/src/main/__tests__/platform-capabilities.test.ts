import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getDesktopCapabilitiesForPlatform,
  resolvePreparedScreenAudioMode,
  resolveScreenAudioMode,
} from "../platform-capabilities";
import type { TDesktopCapabilities } from "../types";

void describe("getDesktopCapabilitiesForPlatform", () => {
  void it("maps windows capabilities", () => {
    const capabilities = getDesktopCapabilitiesForPlatform("win32");

    assert.equal(capabilities.platform, "windows");
    assert.equal(capabilities.systemAudio, "supported");
    assert.equal(capabilities.perAppAudio, "supported");
    assert.equal(capabilities.globalPushKeybinds, "supported");
    assert.deepEqual(capabilities.issues, []);
  });

  void it("maps macOS capabilities", () => {
    const capabilities = getDesktopCapabilitiesForPlatform("darwin");

    assert.equal(capabilities.platform, "macos");
    assert.equal(capabilities.systemAudio, "supported");
    assert.equal(capabilities.perAppAudio, "supported");
    assert.equal(capabilities.globalPushKeybinds, "supported");
    assert.match(capabilities.notes.join(" "), /ScreenCaptureKit/i);
  });

  void it("maps linux capabilities as best-effort", () => {
    const capabilities = getDesktopCapabilitiesForPlatform("linux");

    assert.equal(capabilities.platform, "linux");
    assert.equal(capabilities.systemAudio, "best-effort");
    assert.equal(capabilities.perAppAudio, "best-effort");
    assert.equal(capabilities.globalPushKeybinds, "best-effort");
  });
});

void describe("resolveScreenAudioMode", () => {
  void it("falls back from per-app to system when per-app unsupported", () => {
    const capabilities: TDesktopCapabilities = {
      platform: "windows",
      systemAudio: "supported",
      perAppAudio: "unsupported",
      globalPushKeybinds: "supported",
      issues: [],
      notes: [],
    };

    const resolved = resolveScreenAudioMode("app", capabilities);

    assert.equal(resolved.effectiveMode, "system");
    assert.match(resolved.warning ?? "", /Falling back to system audio/);
  });

  void it("falls back to none when audio is unsupported", () => {
    const capabilities: TDesktopCapabilities = {
      platform: "macos",
      systemAudio: "unsupported",
      perAppAudio: "unsupported",
      globalPushKeybinds: "supported",
      issues: [],
      notes: [],
    };

    const resolved = resolveScreenAudioMode("system", capabilities);

    assert.equal(resolved.effectiveMode, "none");
    assert.match(resolved.warning ?? "", /Continuing without shared audio/);
  });
});

void describe("resolvePreparedScreenAudioMode", () => {
  void it("falls back when linux per-app audio is requested without an explicit target", () => {
    const capabilities: TDesktopCapabilities = {
      platform: "linux",
      systemAudio: "best-effort",
      perAppAudio: "best-effort",
      globalPushKeybinds: "best-effort",
      issues: [],
      notes: [],
    };

    const resolved = resolvePreparedScreenAudioMode(
      {
        sourceId: "window:123",
        audioMode: "app",
      },
      capabilities,
    );

    assert.equal(resolved.effectiveMode, "system");
    assert.match(
      resolved.warning ?? "",
      /Linux requires choosing a running app audio target/i,
    );
  });

  void it("keeps linux per-app audio when an explicit target is selected", () => {
    const capabilities: TDesktopCapabilities = {
      platform: "linux",
      systemAudio: "best-effort",
      perAppAudio: "best-effort",
      globalPushKeybinds: "best-effort",
      issues: [],
      notes: [],
    };

    const resolved = resolvePreparedScreenAudioMode(
      {
        sourceId: "window:123",
        audioMode: "app",
        appAudioTargetId: "node:77",
      },
      capabilities,
    );

    assert.equal(resolved.effectiveMode, "app");
    assert.equal(
      resolved.warning,
      "Per-app audio capture is best-effort on this platform and may fail.",
    );
  });
});
