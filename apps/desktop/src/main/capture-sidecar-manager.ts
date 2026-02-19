import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import EventEmitter from "node:events";
import fs from "node:fs";
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

type TCaptureSidecarManagerOptions = {
  restartDelayMs?: number;
  resolveBinaryPath?: () => string | undefined;
  spawnSidecar?: () => ChildProcessWithoutNullStreams;
};

const SIDECAR_BINARY_NAME =
  process.platform === "win32"
    ? "sharkord-capture-sidecar.exe"
    : "sharkord-capture-sidecar";

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
