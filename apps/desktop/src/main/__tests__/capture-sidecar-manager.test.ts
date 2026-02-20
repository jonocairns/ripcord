import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import path from "path";
import {
  CaptureSidecarManager,
  toPcmAppAudioFrame,
} from "../capture-sidecar-manager";
import type {
  TAppAudioFrame,
  TAppAudioPcmFrame,
  TAppAudioStatusEvent,
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
