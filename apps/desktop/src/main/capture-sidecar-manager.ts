import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import EventEmitter from "node:events";
import fs from "node:fs";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import type {
  TAppAudioFrame,
  TAppAudioPcmFrame,
  TAppAudioSession,
  TAppAudioStatusEvent,
  TDesktopAppAudioTargetsResult,
  TDesktopPushKeybindEvent,
  TDesktopPushKeybindsInput,
  TGlobalPushKeybindRegistrationResult,
  TMicDevicesResult,
  TStartAppAudioCaptureInput,
} from "./types";

type TSidecarResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    message?: string;
  };
};

type TSidecarEvent = {
  event: string;
  params?: unknown;
};

type TPendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

type TSidecarStatus = {
  available: boolean;
  reason?: string;
};

type TAppAudioBinaryEgressInfo = {
  port: number;
  framing?: string;
  protocolVersion?: number;
};

type TCaptureSidecarManagerOptions = {
  restartDelayMs?: number;
  resolveBinaryPath?: () => string | undefined;
  spawnSidecar?: () => ChildProcessWithoutNullStreams;
};

const SIDECAR_BINARY_NAME =
  process.platform === "win32"
    ? "sharkord-capture-sidecar.exe"
    : "sharkord-capture-sidecar";
const BINARY_APP_AUDIO_EGRESS_HOST = "127.0.0.1";
const BINARY_APP_AUDIO_EGRESS_CONNECT_TIMEOUT_MS = 1_000;
const MAX_BINARY_APP_AUDIO_FRAME_SIZE_BYTES = 4 * 1024 * 1024;
const BINARY_APP_AUDIO_EGRESS_RETRY_DELAY_MS = 3_000;

const runtimeRequire: NodeJS.Require | undefined =
  typeof require === "function" ? require : undefined;

type TElectronAppLike = {
  isPackaged?: boolean;
};

const resolveElectronApp = (): TElectronAppLike | undefined => {
  try {
    if (!runtimeRequire) {
      return undefined;
    }

    const electronModule = runtimeRequire("electron") as {
      app?: TElectronAppLike;
    };

    return electronModule.app;
  } catch {
    return undefined;
  }
};

const isSidecarResponse = (value: unknown): value is TSidecarResponse => {
  if (!value || typeof value !== "object") {
    return false;
  }

  return "id" in value;
};

const isSidecarEvent = (value: unknown): value is TSidecarEvent => {
  if (!value || typeof value !== "object") {
    return false;
  }

  return "event" in value;
};

const toPcmAppAudioFrame = (
  frame: TAppAudioFrame,
): TAppAudioPcmFrame | undefined => {
  if (frame.encoding !== "f32le_base64") {
    return undefined;
  }

  const pcmBytes = Buffer.from(frame.pcmBase64, "base64");
  if (pcmBytes.length === 0) {
    return undefined;
  }

  if (pcmBytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    console.warn(
      "[desktop] Dropping malformed app audio frame with invalid PCM byte length",
      {
        sessionId: frame.sessionId,
        sequence: frame.sequence,
        pcmByteLength: pcmBytes.length,
      },
    );
    return undefined;
  }

  const expectedBytes =
    frame.frameCount * frame.channels * Float32Array.BYTES_PER_ELEMENT;
  if (expectedBytes !== pcmBytes.length) {
    console.warn(
      "[desktop] Dropping malformed app audio frame with mismatched sample count",
      {
        sessionId: frame.sessionId,
        sequence: frame.sequence,
        expectedBytes,
        actualBytes: pcmBytes.length,
      },
    );
    return undefined;
  }

  const pcmBuffer = pcmBytes.buffer.slice(
    pcmBytes.byteOffset,
    pcmBytes.byteOffset + pcmBytes.byteLength,
  );

  return {
    sessionId: frame.sessionId,
    targetId: frame.targetId,
    sequence: frame.sequence,
    sampleRate: frame.sampleRate,
    channels: frame.channels,
    frameCount: frame.frameCount,
    pcm: new Float32Array(pcmBuffer),
    protocolVersion: frame.protocolVersion,
    droppedFrameCount: frame.droppedFrameCount,
  };
};

class CaptureSidecarManager {
  private sidecarProcess: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private requestId = 0;
  private pendingRequests = new Map<string, TPendingRequest>();
  private activeSessionId: string | undefined;
  private pushKeybindActiveState: Record<"talk" | "mute", boolean> = {
    talk: false,
    mute: false,
  };
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private lastKnownError: string | undefined;
  private appAudioBinaryEgressSocket: Socket | undefined;
  private appAudioBinaryEgressConnectPromise: Promise<void> | undefined;
  private appAudioBinaryEgressReadBuffer: Buffer = Buffer.alloc(0);
  private appAudioBinarySessionIds = new Set<string>();
  private nextAppAudioBinaryEgressRetryAt = 0;
  private appAudioBinaryEgressUnsupported = false;
  private readonly events = new EventEmitter();
  private readonly restartDelayMs: number;
  private readonly resolveBinaryPathOverride:
    | (() => string | undefined)
    | undefined;
  private readonly spawnSidecarOverride:
    | (() => ChildProcessWithoutNullStreams)
    | undefined;

  constructor(options: TCaptureSidecarManagerOptions = {}) {
    this.restartDelayMs = options.restartDelayMs ?? 1_000;
    this.resolveBinaryPathOverride = options.resolveBinaryPath;
    this.spawnSidecarOverride = options.spawnSidecar;
  }

  onFrame(listener: (frame: TAppAudioFrame) => void) {
    this.events.on("frame", listener);
    return () => {
      this.events.off("frame", listener);
    };
  }

  onPcmFrame(listener: (frame: TAppAudioPcmFrame) => void) {
    this.events.on("frame-pcm", listener);
    return () => {
      this.events.off("frame-pcm", listener);
    };
  }

  onStatus(listener: (event: TAppAudioStatusEvent) => void) {
    this.events.on("status", listener);
    return () => {
      this.events.off("status", listener);
    };
  }

  onPushKeybind(listener: (event: TDesktopPushKeybindEvent) => void) {
    this.events.on("push-keybind", listener);
    return () => {
      this.events.off("push-keybind", listener);
    };
  }

  async getStatus(): Promise<TSidecarStatus> {
    try {
      await this.ensureSidecarReady();

      return {
        available: true,
      };
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Unknown sidecar error";

      return {
        available: false,
        reason,
      };
    }
  }

  async listAppAudioTargets(
    sourceId?: string,
  ): Promise<TDesktopAppAudioTargetsResult> {
    const response = await this.sendRequest("audio_targets.list", {
      sourceId,
    });

    return response as TDesktopAppAudioTargetsResult;
  }

  async startAppAudioCapture(
    input: TStartAppAudioCaptureInput,
  ): Promise<TAppAudioSession> {
    if (
      !this.appAudioBinaryEgressUnsupported &&
      Date.now() >= this.nextAppAudioBinaryEgressRetryAt
    ) {
      void this.ensureAppAudioBinaryEgress().catch((error) => {
        if (this.isAppAudioBinaryEgressUnsupportedError(error)) {
          this.appAudioBinaryEgressUnsupported = true;
          this.nextAppAudioBinaryEgressRetryAt = Number.MAX_SAFE_INTEGER;
          return;
        }

        this.nextAppAudioBinaryEgressRetryAt =
          Date.now() + BINARY_APP_AUDIO_EGRESS_RETRY_DELAY_MS;
        console.warn(
          "[desktop] Failed to initialize binary app-audio egress",
          error,
        );
      });
    }

    const response = await this.sendRequest("audio_capture.start", input);
    const session = response as TAppAudioSession;

    this.activeSessionId = session.sessionId;
    return session;
  }

  async stopAppAudioCapture(sessionId?: string): Promise<void> {
    const targetSessionId = sessionId || this.activeSessionId;

    if (!targetSessionId) {
      return;
    }

    try {
      await this.sendRequest("audio_capture.stop", {
        sessionId: targetSessionId,
      });
    } catch (error) {
      console.warn("[desktop] Failed to stop app audio capture", error);
    } finally {
      if (!sessionId || sessionId === this.activeSessionId) {
        if (targetSessionId) {
          this.appAudioBinarySessionIds.delete(targetSessionId);
        }
        this.activeSessionId = undefined;
      }
    }
  }

  async listMicDevices(): Promise<TMicDevicesResult> {
    const response = await this.sendRequest("mic_devices.list", {});
    return response as TMicDevicesResult;
  }

  async setPushKeybinds(
    input: TDesktopPushKeybindsInput,
  ): Promise<TGlobalPushKeybindRegistrationResult> {
    const response = await this.sendRequest("push_keybinds.set", input);

    return response as TGlobalPushKeybindRegistrationResult;
  }

  async dispose() {
    this.shuttingDown = true;
    clearTimeout(this.restartTimer);

    await this.stopAppAudioCapture();
    this.closeAppAudioBinaryEgressSocket();

    if (this.sidecarProcess && !this.sidecarProcess.killed) {
      this.sidecarProcess.kill();
    }
  }

  private getCandidatePaths() {
    const candidates: string[] = [];
    const isPackaged = resolveElectronApp()?.isPackaged === true;

    if (isPackaged) {
      candidates.push(
        path.join(
          process.resourcesPath,
          "sidecar",
          "bin",
          process.platform,
          SIDECAR_BINARY_NAME,
        ),
      );
      candidates.push(
        path.join(process.resourcesPath, "sidecar", "bin", SIDECAR_BINARY_NAME),
      );

      return candidates;
    }

    candidates.push(
      path.resolve(
        __dirname,
        "..",
        "..",
        "sidecar",
        "bin",
        process.platform,
        SIDECAR_BINARY_NAME,
      ),
    );
    candidates.push(
      path.resolve(
        __dirname,
        "..",
        "..",
        "sidecar",
        "target",
        "release",
        SIDECAR_BINARY_NAME,
      ),
    );
    candidates.push(
      path.resolve(
        process.cwd(),
        "sidecar",
        "bin",
        process.platform,
        SIDECAR_BINARY_NAME,
      ),
    );

    return candidates;
  }

  private resolveSidecarBinaryPath() {
    if (this.resolveBinaryPathOverride) {
      return this.resolveBinaryPathOverride();
    }

    const candidates = this.getCandidatePaths();

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private setupProcessListeners(processRef: ChildProcessWithoutNullStreams) {
    processRef.stdout.setEncoding("utf8");
    processRef.stderr.setEncoding("utf8");

    processRef.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;

      let newlineIndex = this.stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

        if (line) {
          this.handleSidecarLine(line);
        }

        newlineIndex = this.stdoutBuffer.indexOf("\n");
      }
    });

    processRef.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;

      let newlineIndex = this.stderrBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.stderrBuffer.slice(0, newlineIndex).trim();
        this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);

        if (line) {
          console.info("[capture-sidecar]", line);
        }

        newlineIndex = this.stderrBuffer.indexOf("\n");
      }
    });

    const processEvents = processRef as unknown as NodeJS.EventEmitter;

    processEvents.on(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        const reason = `Capture sidecar exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        this.handleSidecarExit(reason);
      },
    );

    processEvents.on("error", (error: Error) => {
      this.handleSidecarExit(`Capture sidecar error: ${error.message}`);
    });
  }

  private startSidecarProcess() {
    if (this.spawnSidecarOverride) {
      const processRef = this.spawnSidecarOverride();

      this.sidecarProcess = processRef;
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      this.setupProcessListeners(processRef);
      return;
    }

    const sidecarBinaryPath = this.resolveSidecarBinaryPath();

    if (!sidecarBinaryPath) {
      throw new Error(
        "Rust capture sidecar binary not found. Run `bun run build:sidecar` in apps/desktop.",
      );
    }

    const processRef = spawn(sidecarBinaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.sidecarProcess = processRef;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.setupProcessListeners(processRef);
  }

  private async ensureSidecarReady() {
    if (!this.sidecarProcess || this.sidecarProcess.killed) {
      this.startSidecarProcess();
      await this.sendRequestInternal("health.ping", {});
      this.lastKnownError = undefined;
    }
  }

  private scheduleRestart() {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      void this.ensureSidecarReady().catch((error) => {
        const message =
          error instanceof Error ? error.message : "Unknown sidecar error";
        this.lastKnownError = message;
      });
    }, this.restartDelayMs);
  }

  private handleSidecarExit(reason: string) {
    this.sidecarProcess = undefined;
    this.lastKnownError = reason;
    this.closeAppAudioBinaryEgressSocket();

    for (const pendingRequest of this.pendingRequests.values()) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(new Error(reason));
    }
    this.pendingRequests.clear();

    if (this.activeSessionId) {
      this.events.emit("status", {
        sessionId: this.activeSessionId,
        targetId: "unknown",
        reason: "sidecar_exited",
        protocolVersion: 1,
      } satisfies TAppAudioStatusEvent);
      this.activeSessionId = undefined;
    }

    (["talk", "mute"] as const).forEach((kind) => {
      if (!this.pushKeybindActiveState[kind]) {
        return;
      }

      this.pushKeybindActiveState[kind] = false;
      this.events.emit("push-keybind", {
        kind,
        active: false,
      } satisfies TDesktopPushKeybindEvent);
    });

    if (!this.shuttingDown) {
      this.scheduleRestart();
    }
  }

  private handleSidecarLine(rawLine: string) {
    let parsedLine: unknown;

    try {
      parsedLine = JSON.parse(rawLine);
    } catch (error) {
      console.warn("[desktop] Failed to parse sidecar JSON line", error);
      return;
    }

    if (isSidecarResponse(parsedLine)) {
      const pendingRequest = this.pendingRequests.get(parsedLine.id);
      if (!pendingRequest) {
        return;
      }

      clearTimeout(pendingRequest.timeout);
      this.pendingRequests.delete(parsedLine.id);

      if (parsedLine.ok) {
        pendingRequest.resolve(parsedLine.result);
      } else {
        const message =
          parsedLine.error?.message || "Unknown sidecar request failure";
        pendingRequest.reject(new Error(message));
      }

      return;
    }

    if (!isSidecarEvent(parsedLine)) {
      return;
    }

    if (parsedLine.event === "audio_capture.frame") {
      const frame = parsedLine.params as TAppAudioFrame;
      this.events.emit("frame", frame);

      if (this.appAudioBinarySessionIds.has(frame.sessionId)) {
        return;
      }

      const pcmFrame = toPcmAppAudioFrame(frame);
      if (pcmFrame) {
        this.events.emit("frame-pcm", pcmFrame);
      }

      return;
    }

    if (parsedLine.event === "audio_capture.ended") {
      const statusEvent = parsedLine.params as TAppAudioStatusEvent;

      if (statusEvent.sessionId === this.activeSessionId) {
        this.appAudioBinarySessionIds.delete(statusEvent.sessionId);
        this.activeSessionId = undefined;
      }

      this.events.emit("status", statusEvent);
      return;
    }

    if (parsedLine.event === "push_keybind.state") {
      const pushEvent = parsedLine.params as TDesktopPushKeybindEvent;
      if (pushEvent.kind !== "talk" && pushEvent.kind !== "mute") {
        return;
      }

      this.pushKeybindActiveState[pushEvent.kind] = pushEvent.active;
      this.events.emit("push-keybind", pushEvent);
    }
  }

  private closeAppAudioBinaryEgressSocket() {
    this.appAudioBinaryEgressReadBuffer = Buffer.alloc(0);
    this.appAudioBinarySessionIds.clear();

    if (!this.appAudioBinaryEgressSocket) {
      return;
    }

    const socket = this.appAudioBinaryEgressSocket;
    this.appAudioBinaryEgressSocket = undefined;
    socket.removeAllListeners();
    socket.destroy();
  }

  private parseAppAudioBinaryFramePayload(
    payload: Buffer,
  ): TAppAudioPcmFrame | undefined {
    let offset = 0;

    const readUInt16 = (): number | undefined => {
      if (payload.length < offset + 2) {
        return undefined;
      }

      const value = payload.readUInt16LE(offset);
      offset += 2;
      return value;
    };

    const readUInt32 = (): number | undefined => {
      if (payload.length < offset + 4) {
        return undefined;
      }

      const value = payload.readUInt32LE(offset);
      offset += 4;
      return value;
    };

    const readUInt64AsNumber = (): number | undefined => {
      if (payload.length < offset + 8) {
        return undefined;
      }

      const value = payload.readBigUInt64LE(offset);
      offset += 8;

      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        return undefined;
      }

      return Number(value);
    };

    const sessionIdLength = readUInt16();
    if (!sessionIdLength || payload.length < offset + sessionIdLength) {
      return undefined;
    }
    const sessionId = payload.toString(
      "utf8",
      offset,
      offset + sessionIdLength,
    );
    offset += sessionIdLength;

    const targetIdLength = readUInt16();
    if (!targetIdLength || payload.length < offset + targetIdLength) {
      return undefined;
    }
    const targetId = payload.toString("utf8", offset, offset + targetIdLength);
    offset += targetIdLength;

    const sequence = readUInt64AsNumber();
    const sampleRate = readUInt32();
    const channels = readUInt16();
    const frameCount = readUInt32();
    const protocolVersion = readUInt32();
    const droppedFrameCount = readUInt32();
    const pcmByteLength = readUInt32();

    if (
      sequence === undefined ||
      sampleRate === undefined ||
      channels === undefined ||
      frameCount === undefined ||
      protocolVersion === undefined ||
      droppedFrameCount === undefined ||
      pcmByteLength === undefined
    ) {
      return undefined;
    }

    if (
      sessionId.length === 0 ||
      targetId.length === 0 ||
      !Number.isInteger(sequence) ||
      sequence < 0 ||
      !Number.isInteger(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isInteger(channels) ||
      channels <= 0 ||
      !Number.isInteger(frameCount) ||
      frameCount <= 0 ||
      !Number.isInteger(protocolVersion) ||
      protocolVersion <= 0 ||
      !Number.isInteger(droppedFrameCount) ||
      droppedFrameCount < 0 ||
      !Number.isInteger(pcmByteLength) ||
      pcmByteLength <= 0 ||
      pcmByteLength % Float32Array.BYTES_PER_ELEMENT !== 0 ||
      payload.length !== offset + pcmByteLength
    ) {
      return undefined;
    }

    const pcmSlice = payload.subarray(offset, offset + pcmByteLength);
    const pcmArrayBuffer = pcmSlice.buffer.slice(
      pcmSlice.byteOffset,
      pcmSlice.byteOffset + pcmSlice.byteLength,
    );
    const pcm = new Float32Array(pcmArrayBuffer);
    const expectedSampleCount = frameCount * channels;
    if (pcm.length !== expectedSampleCount) {
      return undefined;
    }

    return {
      sessionId,
      targetId,
      sequence,
      sampleRate,
      channels,
      frameCount,
      pcm,
      protocolVersion,
      droppedFrameCount,
    };
  }

  private isAppAudioBinaryEgressUnsupportedError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return /unknown method:\s*audio_capture\.binary_egress_info/i.test(
      error.message,
    );
  }

  private handleAppAudioBinaryEgressData(chunk: Buffer) {
    this.appAudioBinaryEgressReadBuffer =
      this.appAudioBinaryEgressReadBuffer.length === 0
        ? chunk
        : Buffer.concat([this.appAudioBinaryEgressReadBuffer, chunk]);

    const buffer = this.appAudioBinaryEgressReadBuffer;
    let offset = 0;

    while (buffer.length >= offset + 4) {
      const payloadLength = buffer.readUInt32LE(offset);
      if (
        payloadLength <= 0 ||
        payloadLength > MAX_BINARY_APP_AUDIO_FRAME_SIZE_BYTES
      ) {
        console.warn(
          "[desktop] Dropping invalid binary app-audio frame length",
          payloadLength,
        );
        this.closeAppAudioBinaryEgressSocket();
        return;
      }

      if (buffer.length < offset + 4 + payloadLength) {
        break;
      }

      const payloadStart = offset + 4;
      const payloadEnd = payloadStart + payloadLength;
      const payload = buffer.subarray(payloadStart, payloadEnd);
      const frame = this.parseAppAudioBinaryFramePayload(payload);
      if (frame) {
        this.appAudioBinarySessionIds.add(frame.sessionId);
        this.events.emit("frame-pcm", frame);
      } else {
        console.warn(
          "[desktop] Dropping malformed binary app-audio frame payload",
        );
      }

      offset = payloadEnd;
    }

    if (offset <= 0) {
      return;
    }

    if (offset >= buffer.length) {
      this.appAudioBinaryEgressReadBuffer = Buffer.alloc(0);
      return;
    }

    this.appAudioBinaryEgressReadBuffer = Buffer.from(buffer.subarray(offset));
  }

  private async ensureAppAudioBinaryEgress(): Promise<void> {
    if (
      this.appAudioBinaryEgressSocket &&
      !this.appAudioBinaryEgressSocket.destroyed &&
      this.appAudioBinaryEgressSocket.readable
    ) {
      return;
    }

    if (this.appAudioBinaryEgressConnectPromise) {
      return this.appAudioBinaryEgressConnectPromise;
    }

    this.appAudioBinaryEgressConnectPromise = (async () => {
      await this.ensureSidecarReady();

      const response = await this.sendRequest(
        "audio_capture.binary_egress_info",
        {},
      );
      const info = response as TAppAudioBinaryEgressInfo;

      if (
        !Number.isInteger(info.port) ||
        info.port <= 0 ||
        info.port > 65_535
      ) {
        throw new Error("Invalid binary app-audio egress port");
      }

      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({
          host: BINARY_APP_AUDIO_EGRESS_HOST,
          port: info.port,
        });

        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("Timed out connecting to binary app-audio egress"));
        }, BINARY_APP_AUDIO_EGRESS_CONNECT_TIMEOUT_MS);

        const cleanupTimeout = () => {
          clearTimeout(timeout);
        };

        const onInitialError = (error: Error) => {
          cleanupTimeout();
          socket.destroy();
          reject(error);
        };

        socket.once("connect", () => {
          cleanupTimeout();
          socket.removeListener("error", onInitialError);
          socket.setNoDelay(true);

          socket.on("data", (data) => {
            this.handleAppAudioBinaryEgressData(data);
          });

          socket.on("error", (error) => {
            console.warn(
              "[desktop] Binary app-audio egress socket error",
              error,
            );
            this.closeAppAudioBinaryEgressSocket();
          });

          socket.on("close", () => {
            if (this.appAudioBinaryEgressSocket === socket) {
              this.closeAppAudioBinaryEgressSocket();
            }
          });

          this.closeAppAudioBinaryEgressSocket();
          this.appAudioBinaryEgressSocket = socket;
          this.appAudioBinaryEgressUnsupported = false;
          this.nextAppAudioBinaryEgressRetryAt = 0;
          resolve();
        });

        socket.once("error", onInitialError);
      });
    })().finally(() => {
      this.appAudioBinaryEgressConnectPromise = undefined;
    });

    return this.appAudioBinaryEgressConnectPromise;
  }

  private async sendRequestInternal(method: string, params: unknown) {
    const processRef = this.sidecarProcess;

    if (!processRef || processRef.killed || !processRef.stdin.writable) {
      throw new Error(this.lastKnownError || "Capture sidecar is not running.");
    }

    const id = `${Date.now()}-${this.requestId++}`;
    const payload = JSON.stringify({
      id,
      method,
      params,
    });

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for sidecar response (${method})`));
      }, 5_000);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout,
      });
    });

    processRef.stdin.write(`${payload}\n`);

    return responsePromise;
  }

  private async sendRequest(method: string, params: unknown) {
    await this.ensureSidecarReady();
    return this.sendRequestInternal(method, params);
  }
}

const captureSidecarManager = new CaptureSidecarManager();

export { CaptureSidecarManager, captureSidecarManager, toPcmAppAudioFrame };
export type { TCaptureSidecarManagerOptions };
