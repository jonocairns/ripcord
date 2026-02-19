import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getDesktopCapabilitiesForPlatform,
  resolveScreenAudioMode,
} from "../platform-capabilities";
import type { TDesktopCapabilities } from "../types";

void describe("getDesktopCapabilitiesForPlatform", () => {
  void it("maps windows capabilities", () => {
    const capabilities = getDesktopCapabilitiesForPlatform("win32");

    assert.equal(capabilities.platform, "windows");
    assert.equal(capabilities.systemAudio, "supported");
    assert.equal(capabilities.perAppAudio, "supported");
  });

  void it("maps macOS capabilities", () => {
    const capabilities = getDesktopCapabilitiesForPlatform("darwin");

    assert.equal(capabilities.platform, "macos");
    assert.equal(capabilities.systemAudio, "unsupported");
    assert.equal(capabilities.perAppAudio, "unsupported");
  });

  void it("maps linux capabilities as best-effort", () => {
    const capabilities = getDesktopCapabilitiesForPlatform("linux");

    assert.equal(capabilities.platform, "linux");
    assert.equal(capabilities.systemAudio, "best-effort");
    assert.equal(capabilities.perAppAudio, "best-effort");
  });
});

void describe("resolveScreenAudioMode", () => {
  void it("falls back from per-app to system when per-app unsupported", () => {
    const capabilities: TDesktopCapabilities = {
      platform: "windows",
      systemAudio: "supported",
      perAppAudio: "unsupported",
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
      notes: [],
    };

    const resolved = resolveScreenAudioMode("system", capabilities);

    assert.equal(resolved.effectiveMode, "none");
    assert.match(resolved.warning ?? "", /Continuing without shared audio/);
  });
});
