import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import EventEmitter from "node:events";
import fs from "node:fs";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import type {
  TAppAudioFrame,
  TAppAudioSession,
  TAppAudioStatusEvent,
  TDesktopAppAudioTargetsResult,
  TDesktopPushKeybindEvent,
  TDesktopPushKeybindsInput,
  TGlobalPushKeybindRegistrationResult,
  TStartAppAudioCaptureInput,
  TStartVoiceFilterInput,
  TVoiceFilterFrame,
  TVoiceFilterPcmFrame,
  TVoiceFilterSession,
  TVoiceFilterStatusEvent,
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

type TVoiceFilterBinaryIngressInfo = {
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
const BINARY_VOICE_FILTER_INGRESS_HOST = "127.0.0.1";
const BINARY_VOICE_FILTER_CONNECT_TIMEOUT_MS = 1_000;
const MAX_BINARY_VOICE_FILTER_FRAME_SIZE_BYTES = 4 * 1024 * 1024;

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

class CaptureSidecarManager {
  private sidecarProcess: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private requestId = 0;
  private pendingRequests = new Map<string, TPendingRequest>();
  private activeSessionId: string | undefined;
  private activeVoiceFilterSessionId: string | undefined;
  private pushKeybindActiveState: Record<"talk" | "mute", boolean> = {
    talk: false,
    mute: false,
  };
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private lastKnownError: string | undefined;
  private voiceFilterBinarySocket: Socket | undefined;
  private voiceFilterBinaryConnectPromise: Promise<void> | undefined;
  private nextVoiceFilterBinaryRetryAt = 0;
  private readonly events = new EventEmitter();
  private readonly restartDelayMs: number;
  private readonly resolveBinaryPathOverride: (() => string | undefined) | undefined;
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

  onStatus(listener: (event: TAppAudioStatusEvent) => void) {
    this.events.on("status", listener);
    return () => {
      this.events.off("status", listener);
    };
  }

  onVoiceFilterFrame(listener: (frame: TVoiceFilterFrame) => void) {
    this.events.on("voice-filter-frame", listener);
    return () => {
      this.events.off("voice-filter-frame", listener);
    };
  }

  onVoiceFilterStatus(listener: (event: TVoiceFilterStatusEvent) => void) {
    this.events.on("voice-filter-status", listener);
    return () => {
      this.events.off("voice-filter-status", listener);
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
        this.activeSessionId = undefined;
      }
    }
  }

  async startVoiceFilterSession(
    input: TStartVoiceFilterInput,
  ): Promise<TVoiceFilterSession> {
    const response = await this.sendRequest("voice_filter.start", input);
    const session = response as TVoiceFilterSession;
    this.activeVoiceFilterSessionId = session.sessionId;
    void this.ensureVoiceFilterBinaryIngress().catch((error) => {
      console.warn("[desktop] Failed to initialize binary voice filter ingress", error);
    });

    return session;
  }

  async stopVoiceFilterSession(sessionId?: string): Promise<void> {
    const targetSessionId = sessionId || this.activeVoiceFilterSessionId;

    if (!targetSessionId) {
      return;
    }

    try {
      await this.sendRequest("voice_filter.stop", {
        sessionId: targetSessionId,
      });
    } catch (error) {
      console.warn("[desktop] Failed to stop voice filter session", error);
    } finally {
      if (!sessionId || sessionId === this.activeVoiceFilterSessionId) {
        this.activeVoiceFilterSessionId = undefined;
      }
    }
  }

  pushVoiceFilterFrame(frame: TVoiceFilterFrame): void {
    void this.sendNotification("voice_filter.push_frame", frame).catch((error) => {
      console.warn("[desktop] Failed to push voice filter frame", error);
    });
  }

  pushVoiceFilterPcmFrame(frame: TVoiceFilterPcmFrame): void {
    const expectedSampleCount = frame.frameCount * frame.channels;
    if (frame.pcm.length !== expectedSampleCount) {
      console.warn("[desktop] Dropping malformed PCM voice filter frame", {
        sessionId: frame.sessionId,
        sequence: frame.sequence,
        expectedSampleCount,
        actualSampleCount: frame.pcm.length,
      });
      return;
    }

    if (this.tryPushVoiceFilterBinaryFrame(frame)) {
      return;
    }

    if (Date.now() >= this.nextVoiceFilterBinaryRetryAt) {
      void this.ensureVoiceFilterBinaryIngress().catch(() => {
        this.nextVoiceFilterBinaryRetryAt = Date.now() + 3_000;
      });
    }
    this.pushVoiceFilterFrame(this.toBase64VoiceFilterFrame(frame));
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
    await this.stopVoiceFilterSession();
    this.closeVoiceFilterBinarySocket();

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
        path.join(
          process.resourcesPath,
          "sidecar",
          "bin",
          SIDECAR_BINARY_NAME,
        ),
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
      console.info("[capture-sidecar]", chunk.trim());
    });

    processRef.on("exit", (code, signal) => {
      const reason = `Capture sidecar exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.handleSidecarExit(reason);
    });

    processRef.on("error", (error) => {
      this.handleSidecarExit(`Capture sidecar error: ${error.message}`);
    });
  }

  private startSidecarProcess() {
    if (this.spawnSidecarOverride) {
      const processRef = this.spawnSidecarOverride();

      this.sidecarProcess = processRef;
      this.stdoutBuffer = "";
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
    this.closeVoiceFilterBinarySocket();

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

    if (this.activeVoiceFilterSessionId) {
      this.events.emit("voice-filter-status", {
        sessionId: this.activeVoiceFilterSessionId,
        reason: "sidecar_exited",
        protocolVersion: 1,
      } satisfies TVoiceFilterStatusEvent);
      this.activeVoiceFilterSessionId = undefined;
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

    if (isSidecarEvent(parsedLine)) {
      if (parsedLine.event === "audio_capture.frame") {
        this.events.emit("frame", parsedLine.params as TAppAudioFrame);
        return;
      }

      if (parsedLine.event === "audio_capture.ended") {
        const statusEvent = parsedLine.params as TAppAudioStatusEvent;

        if (statusEvent.sessionId === this.activeSessionId) {
          this.activeSessionId = undefined;
        }

        this.events.emit("status", statusEvent);
        return;
      }

      if (parsedLine.event === "voice_filter.frame") {
        this.events.emit("voice-filter-frame", parsedLine.params as TVoiceFilterFrame);
        return;
      }

      if (parsedLine.event === "voice_filter.ended") {
        const statusEvent = parsedLine.params as TVoiceFilterStatusEvent;

        if (statusEvent.sessionId === this.activeVoiceFilterSessionId) {
          this.activeVoiceFilterSessionId = undefined;
        }

        this.events.emit("voice-filter-status", statusEvent);
        return;
      }

      if (parsedLine.event === "push_keybind.state") {
        const pushEvent = parsedLine.params as TDesktopPushKeybindEvent;
        this.pushKeybindActiveState[pushEvent.kind] = pushEvent.active;
        this.events.emit("push-keybind", pushEvent);
      }
    }
  }

  private toBase64VoiceFilterFrame(frame: TVoiceFilterPcmFrame): TVoiceFilterFrame {
    const pcmBytes = Buffer.from(
      frame.pcm.buffer,
      frame.pcm.byteOffset,
      frame.pcm.byteLength,
    );

    return {
      sessionId: frame.sessionId,
      sequence: frame.sequence,
      sampleRate: frame.sampleRate,
      channels: frame.channels,
      frameCount: frame.frameCount,
      pcmBase64: pcmBytes.toString("base64"),
      protocolVersion: frame.protocolVersion,
      encoding: "f32le_base64",
    };
  }

  private closeVoiceFilterBinarySocket() {
    if (!this.voiceFilterBinarySocket) {
      return;
    }

    this.voiceFilterBinarySocket.removeAllListeners();
    this.voiceFilterBinarySocket.destroy();
    this.voiceFilterBinarySocket = undefined;
  }

  private async ensureVoiceFilterBinaryIngress(): Promise<void> {
    if (
      this.voiceFilterBinarySocket &&
      !this.voiceFilterBinarySocket.destroyed &&
      this.voiceFilterBinarySocket.writable
    ) {
      return;
    }

    if (this.voiceFilterBinaryConnectPromise) {
      return this.voiceFilterBinaryConnectPromise;
    }

    this.voiceFilterBinaryConnectPromise = (async () => {
      await this.ensureSidecarReady();

      const response = await this.sendRequest("voice_filter.binary_ingress_info", {});
      const info = response as TVoiceFilterBinaryIngressInfo;

      if (!Number.isInteger(info.port) || info.port <= 0 || info.port > 65_535) {
        throw new Error("Invalid binary voice filter ingress port");
      }

      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({
          host: BINARY_VOICE_FILTER_INGRESS_HOST,
          port: info.port,
        });

        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("Timed out connecting to binary voice filter ingress"));
        }, BINARY_VOICE_FILTER_CONNECT_TIMEOUT_MS);

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

          socket.on("error", (error) => {
            console.warn("[desktop] Binary voice filter ingress socket error", error);
            this.closeVoiceFilterBinarySocket();
          });
          socket.on("close", () => {
            if (this.voiceFilterBinarySocket === socket) {
              this.voiceFilterBinarySocket = undefined;
            }
          });

          this.closeVoiceFilterBinarySocket();
          this.voiceFilterBinarySocket = socket;
          this.nextVoiceFilterBinaryRetryAt = 0;
          resolve();
        });

        socket.once("error", onInitialError);
      });
    })().finally(() => {
      this.voiceFilterBinaryConnectPromise = undefined;
    });

    return this.voiceFilterBinaryConnectPromise;
  }

  private tryPushVoiceFilterBinaryFrame(frame: TVoiceFilterPcmFrame): boolean {
    const socket = this.voiceFilterBinarySocket;
    if (!socket || socket.destroyed || !socket.writable) {
      return false;
    }

    const sessionIdBytes = Buffer.from(frame.sessionId, "utf8");
    if (sessionIdBytes.length === 0 || sessionIdBytes.length > 0xffff) {
      return false;
    }

    const pcmBytes = Buffer.from(
      frame.pcm.buffer,
      frame.pcm.byteOffset,
      frame.pcm.byteLength,
    );
    if (pcmBytes.length <= 0 || pcmBytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
      return false;
    }

    const payloadLength =
      2 + // session id length
      sessionIdBytes.length +
      8 + // sequence
      4 + // sample rate
      2 + // channels
      4 + // frame count
      4 + // protocol version
      4 + // pcm bytes length
      pcmBytes.length;

    if (payloadLength > MAX_BINARY_VOICE_FILTER_FRAME_SIZE_BYTES) {
      return false;
    }
    if (
      !Number.isInteger(frame.sequence) ||
      frame.sequence < 0 ||
      frame.sequence > Number.MAX_SAFE_INTEGER
    ) {
      return false;
    }
    if (
      !Number.isInteger(frame.sampleRate) ||
      frame.sampleRate <= 0 ||
      frame.sampleRate > 0xffff_ffff
    ) {
      return false;
    }
    if (!Number.isInteger(frame.channels) || frame.channels <= 0 || frame.channels > 0xffff) {
      return false;
    }
    if (
      !Number.isInteger(frame.frameCount) ||
      frame.frameCount <= 0 ||
      frame.frameCount > 0xffff_ffff
    ) {
      return false;
    }
    if (
      !Number.isInteger(frame.protocolVersion) ||
      frame.protocolVersion <= 0 ||
      frame.protocolVersion > 0xffff_ffff
    ) {
      return false;
    }

    const packet = Buffer.allocUnsafe(4 + payloadLength);
    let offset = 0;

    packet.writeUInt32LE(payloadLength, offset);
    offset += 4;

    packet.writeUInt16LE(sessionIdBytes.length, offset);
    offset += 2;
    sessionIdBytes.copy(packet, offset);
    offset += sessionIdBytes.length;

    packet.writeBigUInt64LE(BigInt(frame.sequence), offset);
    offset += 8;

    packet.writeUInt32LE(frame.sampleRate, offset);
    offset += 4;
    packet.writeUInt16LE(frame.channels, offset);
    offset += 2;
    packet.writeUInt32LE(frame.frameCount, offset);
    offset += 4;
    packet.writeUInt32LE(frame.protocolVersion, offset);
    offset += 4;
    packet.writeUInt32LE(pcmBytes.length, offset);
    offset += 4;
    pcmBytes.copy(packet, offset);

    try {
      socket.write(packet);
      return true;
    } catch {
      this.closeVoiceFilterBinarySocket();
      return false;
    }
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

  private async sendNotification(method: string, params: unknown) {
    await this.ensureSidecarReady();

    const processRef = this.sidecarProcess;

    if (!processRef || processRef.killed || !processRef.stdin.writable) {
      throw new Error(this.lastKnownError || "Capture sidecar is not running.");
    }

    const payload = JSON.stringify({
      method,
      params,
    });

    processRef.stdin.write(`${payload}\n`);
  }
}

const captureSidecarManager = new CaptureSidecarManager();

export { CaptureSidecarManager, captureSidecarManager };
export type { TCaptureSidecarManagerOptions };
