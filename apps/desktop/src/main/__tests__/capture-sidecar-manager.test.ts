import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import path from "path";
import { resolveDesktopCaptureCapabilities } from "../capture-capabilities";
import {
  CaptureSidecarManager,
  toPcmAppAudioFrame,
} from "../capture-sidecar-manager";
import {
  getDesktopCapabilitiesForPlatform,
  resolvePreparedScreenAudioMode,
} from "../platform-capabilities";
import type {
  TAppAudioFrame,
  TAppAudioPcmFrame,
  TAppAudioStatusEvent,
  TDesktopPushKeybindEvent,
} from "../types";

const fakeSidecarPath = path.resolve(
  import.meta.dirname,
  "fixtures",
  "fake-sidecar.cjs",
);

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 20,
) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error("Timed out waiting for condition");
};

void describe("CaptureSidecarManager", () => {
  void it("reports unavailable when sidecar binary cannot be resolved", async () => {
    const manager = new CaptureSidecarManager({
      resolveBinaryPath: () => undefined,
      restartDelayMs: 10,
    });

    try {
      const status = await manager.getStatus();

      assert.equal(status.available, false);
      assert.match(status.reason ?? "", /sidecar binary not found/i);
    } finally {
      await manager.dispose();
    }
  });

  void it("starts capture and forwards frame/status events", async () => {
    const manager = new CaptureSidecarManager({
      spawnSidecar: () => {
        return spawn(process.execPath, [fakeSidecarPath], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
      restartDelayMs: 10,
    });

    const frames: TAppAudioFrame[] = [];
    const pcmFrames: TAppAudioPcmFrame[] = [];
    const statusEvents: TAppAudioStatusEvent[] = [];

    const offFrame = manager.onFrame((frame) => {
      frames.push(frame);
    });
    const offPcmFrame = manager.onPcmFrame((frame) => {
      pcmFrames.push(frame);
    });
    const offStatus = manager.onStatus((statusEvent) => {
      statusEvents.push(statusEvent);
    });

    try {
      const status = await manager.getStatus();
      assert.equal(status.available, true);

      const session = await manager.startAppAudioCapture({
        sourceId: "window:1:0",
      });
      assert.ok(session.sessionId);

      await waitFor(() => frames.length > 0);
      await waitFor(() => pcmFrames.length > 0);
      assert.equal(frames[0]?.protocolVersion, 1);
      assert.equal(frames[0]?.encoding, "f32le_base64");
      assert.equal(pcmFrames[0]?.protocolVersion, 1);
      assert.equal(pcmFrames[0]?.pcm.length, 960 * 2);

      await manager.stopAppAudioCapture(session.sessionId);
      await waitFor(() =>
        statusEvents.some((event) => event.reason === "capture_stopped"),
      );
    } finally {
      offFrame();
      offPcmFrame();
      offStatus();
      await manager.dispose();
    }
  });

  void it("validates sidecar capabilities and target list responses", async () => {
    const manager = new CaptureSidecarManager({
      spawnSidecar: () => {
        return spawn(process.execPath, [fakeSidecarPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            FAKE_SIDECAR_PLATFORM: "linux",
            FAKE_SIDECAR_SYSTEM_AUDIO: "best-effort",
            FAKE_SIDECAR_PER_APP_AUDIO: "best-effort",
            FAKE_SIDECAR_SESSION_TYPE: "wayland",
            FAKE_SIDECAR_LINUX_AUDIO_BACKEND: "pulseaudio-native",
            FAKE_SIDECAR_LINUX_AUDIO_BACKEND_USES_SHELL_OUTS: "false",
            FAKE_SIDECAR_LINUX_AUDIO_RUNTIME_AVAILABLE: "true",
            FAKE_SIDECAR_LINUX_AUDIO_CAPTURE_AVAILABLE: "true",
            FAKE_SIDECAR_PORTAL_AVAILABLE: "true",
            FAKE_SIDECAR_APP_AUDIO_TARGET_ENUMERATION_SUPPORTED: "true",
            FAKE_SIDECAR_SOURCE_AUDIO_TARGET_INFERENCE_SUPPORTED: "false",
            FAKE_SIDECAR_SOURCE_AUDIO_TARGET_INFERENCE_REASON:
              "Choose a target manually.",
            FAKE_SIDECAR_SOURCE_AUDIO_TARGET_INFERENCE_REASON_CODE:
              "linux-manual-app-target-selection-required",
            FAKE_SIDECAR_GLOBAL_PUSH_KEYBINDS: "best-effort",
            FAKE_SIDECAR_GLOBAL_PUSH_KEYBINDS_REASON:
              "Uses XWayland in Wayland sessions.",
            FAKE_SIDECAR_GLOBAL_PUSH_KEYBINDS_REASON_CODE:
              "linux-xwayland-best-effort",
            FAKE_SIDECAR_X11_DISPLAY_AVAILABLE: "true",
            FAKE_SIDECAR_LINUX_GLOBAL_SHORTCUTS_PORTAL_CONFIGURED: "true",
            FAKE_SIDECAR_LINUX_GLOBAL_SHORTCUTS_PORTAL_BACKEND: "gnome",
          },
        });
      },
      restartDelayMs: 10,
    });

    try {
      const capabilities = await manager.getCapabilities();
      assert.equal(capabilities.perAppAudio, "best-effort");
      assert.equal(capabilities.sessionType, "wayland");
      assert.equal(capabilities.linuxAudioBackend, "pulseaudio-native");
      assert.equal(capabilities.linuxAudioBackendUsesShellOuts, false);
      assert.equal(capabilities.linuxAudioRuntimeAvailable, true);
      assert.equal(capabilities.linuxAudioCaptureAvailable, true);
      assert.equal(capabilities.portalAvailable, true);
      assert.equal(capabilities.appAudioTargetEnumerationSupported, true);
      assert.equal(capabilities.sourceAudioTargetInferenceSupported, false);
      assert.equal(
        capabilities.sourceAudioTargetInferenceReasonCode,
        "linux-manual-app-target-selection-required",
      );
      assert.equal(capabilities.globalPushKeybinds, "best-effort");
      assert.equal(
        capabilities.globalPushKeybindsReasonCode,
        "linux-xwayland-best-effort",
      );
      assert.equal(capabilities.x11DisplayAvailable, true);
      assert.equal(capabilities.linuxGlobalShortcutsPortalConfigured, true);
      assert.equal(capabilities.linuxGlobalShortcutsPortalBackend, "gnome");

      const targets = await manager.listAppAudioTargets("window:1:0");
      assert.equal(targets.targets.length, 1);
      assert.equal(targets.targets[0]?.id, "pid:1234");
      assert.equal(targets.suggestedTargetId, undefined);
      assert.equal(targets.requiresManualSelection, true);
      assert.match(
        targets.warning ?? "",
        /choosing the app that is producing sound/i,
      );
    } finally {
      await manager.dispose();
    }
  });

  void it("combines Linux capability probing, target listing, and fallback capture start in one flow", async () => {
    const manager = new CaptureSidecarManager({
      spawnSidecar: () => {
        return spawn(process.execPath, [fakeSidecarPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            FAKE_SIDECAR_PLATFORM: "linux",
            FAKE_SIDECAR_SYSTEM_AUDIO: "best-effort",
            FAKE_SIDECAR_PER_APP_AUDIO: "best-effort",
            FAKE_SIDECAR_SESSION_TYPE: "wayland",
            FAKE_SIDECAR_LINUX_AUDIO_BACKEND: "pulseaudio-native",
            FAKE_SIDECAR_LINUX_AUDIO_BACKEND_USES_SHELL_OUTS: "false",
            FAKE_SIDECAR_LINUX_AUDIO_RUNTIME_AVAILABLE: "true",
            FAKE_SIDECAR_LINUX_AUDIO_CAPTURE_AVAILABLE: "true",
            FAKE_SIDECAR_PORTAL_AVAILABLE: "true",
            FAKE_SIDECAR_APP_AUDIO_TARGET_ENUMERATION_SUPPORTED: "true",
            FAKE_SIDECAR_SOURCE_AUDIO_TARGET_INFERENCE_SUPPORTED: "false",
            FAKE_SIDECAR_SOURCE_AUDIO_TARGET_INFERENCE_REASON:
              "Choose a target manually.",
            FAKE_SIDECAR_SOURCE_AUDIO_TARGET_INFERENCE_REASON_CODE:
              "linux-manual-app-target-selection-required",
            FAKE_SIDECAR_REQUIRES_MANUAL_SELECTION: "true",
          },
        });
      },
      restartDelayMs: 10,
    });

    try {
      const status = await manager.getStatus();
      const sidecarCapabilities = await manager.getCapabilities();
      const resolvedCapabilities = resolveDesktopCaptureCapabilities({
        baseCapabilities: getDesktopCapabilitiesForPlatform("linux"),
        sidecarAvailable: status.available,
        sidecarReason: status.reason,
        sidecarPerAppAudioSupported:
          sidecarCapabilities.perAppAudio !== "unsupported",
        sidecarCapabilities,
      });

      assert.equal(resolvedCapabilities.perAppAudio, "best-effort");
      assert.equal(
        resolvedCapabilities.issues.some((issue) => {
          return issue.code === "linux-manual-app-target-selection-required";
        }),
        true,
      );

      const targets = await manager.listAppAudioTargets("window:1:0");
      assert.equal(targets.requiresManualSelection, true);
      assert.equal(targets.targets[0]?.id, "pid:1234");

      const prepared = resolvePreparedScreenAudioMode(
        {
          sourceId: "window:1:0",
          audioMode: "app",
        },
        resolvedCapabilities,
      );

      assert.equal(prepared.effectiveMode, "system");
      assert.match(
        prepared.warning ?? "",
        /Linux requires choosing a running app audio target/i,
      );

      const fallbackSession = await manager.startAppAudioCapture({
        sourceId: "window:1:0",
      });
      assert.ok(fallbackSession.sessionId);
      assert.equal(fallbackSession.targetId, "pid:1234");

      await manager.stopAppAudioCapture(fallbackSession.sessionId);
    } finally {
      await manager.dispose();
    }
  });

  void it("reports unavailable when the macOS helper readiness probe fails", async () => {
    const manager = new CaptureSidecarManager({
      spawnSidecar: () => {
        return spawn(process.execPath, [fakeSidecarPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            FAKE_SIDECAR_PLATFORM: "macos",
            FAKE_SIDECAR_SYSTEM_AUDIO: "unsupported",
            FAKE_SIDECAR_PER_APP_AUDIO: "unsupported",
            FAKE_SIDECAR_REASON:
              "ScreenCaptureKit audio capture requires macOS 13 or newer.",
            FAKE_SIDECAR_REASON_CODE: "macos-version-unsupported",
          },
        });
      },
      restartDelayMs: 10,
    });

    try {
      const status = await manager.getStatus();

      assert.equal(status.available, false);
      assert.match(status.reason ?? "", /macOS 13 or newer/i);
    } finally {
      await manager.dispose();
    }
  });

  void it("returns push keybind registration failures from the sidecar", async () => {
    const manager = new CaptureSidecarManager({
      spawnSidecar: () => {
        return spawn(process.execPath, [fakeSidecarPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            FAKE_SIDECAR_PUSH_TALK_REGISTERED: "false",
            FAKE_SIDECAR_PUSH_MUTE_REGISTERED: "true",
            FAKE_SIDECAR_PUSH_KEYBIND_ERRORS:
              '["Push-to-talk requires an X11 display server connection."]',
          },
        });
      },
      restartDelayMs: 10,
    });

    try {
      const result = await manager.setPushKeybinds({
        pushToTalkKeybind: "Ctrl+Shift+T",
        pushToMuteKeybind: "Ctrl+Shift+M",
      });

      assert.equal(result.talkRegistered, false);
      assert.equal(result.muteRegistered, true);
      assert.deepEqual(result.errors, [
        "Push-to-talk requires an X11 display server connection.",
      ]);
    } finally {
      await manager.dispose();
    }
  });

  void it("keeps linux manual-selection metadata when a suggested target is also present", async () => {
    const manager = new CaptureSidecarManager({
      spawnSidecar: () => {
        return spawn(process.execPath, [fakeSidecarPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            FAKE_SIDECAR_PLATFORM: "linux",
            FAKE_SIDECAR_REQUIRES_MANUAL_SELECTION: "true",
            FAKE_SIDECAR_SUGGESTED_TARGET_ID: "pid:1234",
          },
        });
      },
      restartDelayMs: 10,
    });

    try {
      const targets = await manager.listAppAudioTargets("window:1:0");

      assert.equal(targets.suggestedTargetId, "pid:1234");
      assert.equal(targets.requiresManualSelection, true);
    } finally {
      await manager.dispose();
    }
  });

  void it("refreshes reported capabilities after the sidecar restarts with a different environment", async () => {
    let spawnCount = 0;

    const manager = new CaptureSidecarManager({
      spawnSidecar: () => {
        spawnCount += 1;

        const isFirstSpawn = spawnCount === 1;
        return spawn(process.execPath, [fakeSidecarPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            FAKE_SIDECAR_CRASH_MS: isFirstSpawn ? "80" : "0",
            FAKE_SIDECAR_PLATFORM: "linux",
            FAKE_SIDECAR_SESSION_TYPE: isFirstSpawn ? "x11" : "wayland",
            FAKE_SIDECAR_LINUX_AUDIO_BACKEND: "pulseaudio-native",
            FAKE_SIDECAR_LINUX_AUDIO_BACKEND_USES_SHELL_OUTS: "false",
            FAKE_SIDECAR_LINUX_AUDIO_RUNTIME_AVAILABLE: "true",
            FAKE_SIDECAR_LINUX_AUDIO_CAPTURE_AVAILABLE: isFirstSpawn
              ? "false"
              : "true",
            FAKE_SIDECAR_PER_APP_AUDIO: isFirstSpawn
              ? "unsupported"
              : "best-effort",
            FAKE_SIDECAR_APP_AUDIO_TARGET_ENUMERATION_SUPPORTED: isFirstSpawn
              ? "false"
              : "true",
            FAKE_SIDECAR_APP_AUDIO_TARGET_ENUMERATION_REASON: isFirstSpawn
              ? "Failed to connect to the Linux audio server."
              : "",
            FAKE_SIDECAR_APP_AUDIO_TARGET_ENUMERATION_REASON_CODE: isFirstSpawn
              ? "linux-native-audio-backend-unavailable"
              : "",
            FAKE_SIDECAR_SOURCE_AUDIO_TARGET_INFERENCE_SUPPORTED: isFirstSpawn
              ? "false"
              : "true",
          },
        });
      },
      restartDelayMs: 20,
    });

    try {
      const initialCapabilities = await manager.getCapabilities();
      assert.equal(initialCapabilities.sessionType, "x11");
      assert.equal(initialCapabilities.perAppAudio, "unsupported");
      assert.equal(initialCapabilities.linuxAudioCaptureAvailable, false);

      await waitFor(() => spawnCount >= 2, 3_000);

      const refreshedCapabilities = await manager.getCapabilities();
      assert.equal(refreshedCapabilities.sessionType, "wayland");
      assert.equal(refreshedCapabilities.perAppAudio, "best-effort");
      assert.equal(refreshedCapabilities.linuxAudioCaptureAvailable, true);
      assert.equal(
        refreshedCapabilities.appAudioTargetEnumerationSupported,
        true,
      );
    } finally {
      await manager.dispose();
    }
  });

  void it("restores push keybind registration after the sidecar exits and restarts", async () => {
    let spawnCount = 0;

    const manager = new CaptureSidecarManager({
      spawnSidecar: () => {
        spawnCount += 1;

        const shouldCrash = spawnCount === 1;
        return spawn(process.execPath, [fakeSidecarPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            FAKE_SIDECAR_CRASH_MS: shouldCrash ? "80" : "0",
            FAKE_SIDECAR_EMIT_PUSH_TALK_ACTIVE_ON_SET: "true",
          },
        });
      },
      restartDelayMs: 20,
    });

    const pushEvents: TDesktopPushKeybindEvent[] = [];
    const offPushKeybind = manager.onPushKeybind((event) => {
      pushEvents.push(event);
    });

    try {
      const registration = await manager.setPushKeybinds({
        pushToTalkKeybind: "Ctrl+Shift+T",
      });
      assert.equal(registration.talkRegistered, true);

      await waitFor(() =>
        pushEvents.some((event) => event.kind === "talk" && event.active),
      );
      await waitFor(
        () =>
          pushEvents.some((event) => event.kind === "talk" && !event.active),
        3_000,
      );
      await waitFor(() => spawnCount >= 2, 3_000);
      await waitFor(
        () =>
          pushEvents.filter((event) => event.kind === "talk" && event.active)
            .length >= 2,
        3_000,
      );

      assert.equal(pushEvents[0]?.kind, "talk");
      assert.equal(pushEvents[0]?.active, true);
      assert.equal(
        pushEvents.some((event) => event.kind === "talk" && !event.active),
        true,
      );
      assert.equal(
        pushEvents.filter((event) => event.kind === "talk" && event.active)
          .length >= 2,
        true,
      );
    } finally {
      offPushKeybind();
      await manager.dispose();
    }
  });

  void it("drops malformed app audio frames for pcm forwarding", async () => {
    const manager = new CaptureSidecarManager({
      resolveBinaryPath: () => undefined,
      restartDelayMs: 10,
    });

    try {
      const samples = new Float32Array(4);
      const validBase64 = Buffer.from(samples.buffer).toString("base64");

      const validFrame: TAppAudioFrame = {
        sessionId: "session-1",
        targetId: "pid:1234",
        sequence: 1,
        sampleRate: 48_000,
        channels: 2,
        frameCount: 2,
        pcmBase64: validBase64,
        protocolVersion: 1,
        encoding: "f32le_base64",
      };

      const validPcmFrame = toPcmAppAudioFrame(validFrame);
      assert.equal(validPcmFrame?.pcm.length, 4);

      const malformedByteLength = toPcmAppAudioFrame({
        ...validFrame,
        sequence: 2,
        pcmBase64: Buffer.from([1, 2, 3]).toString("base64"),
      });
      assert.equal(malformedByteLength, undefined);

      const mismatchedSampleCount = toPcmAppAudioFrame({
        ...validFrame,
        sequence: 3,
        frameCount: 3,
      });
      assert.equal(mismatchedSampleCount, undefined);
    } finally {
      await manager.dispose();
    }
  });

  void it("emits sidecar_exited status and recovers after restart", async () => {
    let spawnCount = 0;

    const manager = new CaptureSidecarManager({
      spawnSidecar: () => {
        spawnCount += 1;

        const shouldCrash = spawnCount === 1;
        return spawn(process.execPath, [fakeSidecarPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            FAKE_SIDECAR_CRASH_MS: shouldCrash ? "80" : "0",
          },
        });
      },
      restartDelayMs: 20,
    });

    const statusEvents: TAppAudioStatusEvent[] = [];
    const lifecycleEvents: Array<{
      kind: string;
      reason?: string;
    }> = [];
    const offStatus = manager.onStatus((statusEvent) => {
      statusEvents.push(statusEvent);
    });
    const offLifecycle = manager.onLifecycle((event) => {
      lifecycleEvents.push(event);
    });

    try {
      const session = await manager.startAppAudioCapture({
        sourceId: "window:1:0",
      });
      assert.ok(session.sessionId);

      await waitFor(() =>
        statusEvents.some((event) => event.reason === "sidecar_exited"),
      );

      await waitFor(() => spawnCount >= 2, 3_000);

      const recoveredStatus = await manager.getStatus();
      assert.equal(recoveredStatus.available, true);
      assert.equal(lifecycleEvents[0]?.kind, "ready");
      assert.equal(
        lifecycleEvents.some((event) => event.kind === "exit"),
        true,
      );
      assert.equal(
        lifecycleEvents.filter((event) => event.kind === "ready").length >= 2,
        true,
      );
    } finally {
      offStatus();
      offLifecycle();
      await manager.dispose();
    }
  });
});
