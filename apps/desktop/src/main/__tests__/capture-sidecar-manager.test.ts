import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import path from "path";
import { CaptureSidecarManager } from "../capture-sidecar-manager";
import type { TAppAudioFrame, TAppAudioStatusEvent } from "../types";

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
    const statusEvents: TAppAudioStatusEvent[] = [];

    const offFrame = manager.onFrame((frame) => {
      frames.push(frame);
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
      assert.equal(frames[0]?.protocolVersion, 1);
      assert.equal(frames[0]?.encoding, "f32le_base64");

      await manager.stopAppAudioCapture(session.sessionId);
      await waitFor(() =>
        statusEvents.some((event) => event.reason === "capture_stopped"),
      );
    } finally {
      offFrame();
      offStatus();
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
    const offStatus = manager.onStatus((statusEvent) => {
      statusEvents.push(statusEvent);
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
    } finally {
      offStatus();
      await manager.dispose();
    }
  });
});
