const readline = require("node:readline");

let activeSession = null;
let intervalId = null;
const crashAfterMs = Number(process.env.FAKE_SIDECAR_CRASH_MS || 0);
const parseBooleanEnv = (value) => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return undefined;
};
const parseStringArrayEnv = (value) => {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string")
    ) {
      return parsed;
    }
  } catch {
    // fall through to comma-separated parsing
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};
const capabilityPlatform =
  process.env.FAKE_SIDECAR_PLATFORM || process.platform;
const capabilitySystemAudio =
  process.env.FAKE_SIDECAR_SYSTEM_AUDIO || "supported";
const capabilityPerAppAudio =
  process.env.FAKE_SIDECAR_PER_APP_AUDIO || "supported";
const capabilityReason = process.env.FAKE_SIDECAR_REASON;
const capabilityReasonCode = process.env.FAKE_SIDECAR_REASON_CODE;
const capabilityPerAppAudioReason =
  process.env.FAKE_SIDECAR_PER_APP_AUDIO_REASON;
const capabilityPerAppAudioReasonCode =
  process.env.FAKE_SIDECAR_PER_APP_AUDIO_REASON_CODE;
const capabilitySessionType = process.env.FAKE_SIDECAR_SESSION_TYPE;
const capabilityLinuxAudioBackend =
  process.env.FAKE_SIDECAR_LINUX_AUDIO_BACKEND;
const capabilityLinuxAudioBackendUsesShellOuts = parseBooleanEnv(
  process.env.FAKE_SIDECAR_LINUX_AUDIO_BACKEND_USES_SHELL_OUTS,
);
const capabilityLinuxAudioRuntimeAvailable = parseBooleanEnv(
  process.env.FAKE_SIDECAR_LINUX_AUDIO_RUNTIME_AVAILABLE ??
    process.env.FAKE_SIDECAR_PIPEWIRE_RUNTIME_AVAILABLE,
);
const capabilityLinuxAudioRuntimeReason =
  process.env.FAKE_SIDECAR_LINUX_AUDIO_RUNTIME_REASON ||
  process.env.FAKE_SIDECAR_PIPEWIRE_RUNTIME_REASON;
const capabilityLinuxAudioCaptureAvailable = parseBooleanEnv(
  process.env.FAKE_SIDECAR_LINUX_AUDIO_CAPTURE_AVAILABLE ??
    process.env.FAKE_SIDECAR_PIPEWIRE_TOOLS_AVAILABLE,
);
const capabilityPortalAvailable = parseBooleanEnv(
  process.env.FAKE_SIDECAR_PORTAL_AVAILABLE,
);
const capabilityPortalReason = process.env.FAKE_SIDECAR_PORTAL_REASON;
const capabilityPortalReasonCode = process.env.FAKE_SIDECAR_PORTAL_REASON_CODE;
const capabilityAppAudioTargetEnumerationSupported = parseBooleanEnv(
  process.env.FAKE_SIDECAR_APP_AUDIO_TARGET_ENUMERATION_SUPPORTED,
);
const capabilityAppAudioTargetEnumerationReason =
  process.env.FAKE_SIDECAR_APP_AUDIO_TARGET_ENUMERATION_REASON;
const capabilityAppAudioTargetEnumerationReasonCode =
  process.env.FAKE_SIDECAR_APP_AUDIO_TARGET_ENUMERATION_REASON_CODE;
const capabilitySourceAudioTargetInferenceSupported = parseBooleanEnv(
  process.env.FAKE_SIDECAR_SOURCE_AUDIO_TARGET_INFERENCE_SUPPORTED,
);
const capabilitySourceAudioTargetInferenceReason =
  process.env.FAKE_SIDECAR_SOURCE_AUDIO_TARGET_INFERENCE_REASON;
const capabilitySourceAudioTargetInferenceReasonCode =
  process.env.FAKE_SIDECAR_SOURCE_AUDIO_TARGET_INFERENCE_REASON_CODE;
const capabilityGlobalPushKeybinds =
  process.env.FAKE_SIDECAR_GLOBAL_PUSH_KEYBINDS;
const capabilityGlobalPushKeybindsReason =
  process.env.FAKE_SIDECAR_GLOBAL_PUSH_KEYBINDS_REASON;
const capabilityGlobalPushKeybindsReasonCode =
  process.env.FAKE_SIDECAR_GLOBAL_PUSH_KEYBINDS_REASON_CODE;
const capabilityX11DisplayAvailable = parseBooleanEnv(
  process.env.FAKE_SIDECAR_X11_DISPLAY_AVAILABLE,
);
const capabilityX11DisplayReason = process.env.FAKE_SIDECAR_X11_DISPLAY_REASON;
const capabilityX11DisplayReasonCode =
  process.env.FAKE_SIDECAR_X11_DISPLAY_REASON_CODE;
const listTargetsRequiresManualSelection = parseBooleanEnv(
  process.env.FAKE_SIDECAR_REQUIRES_MANUAL_SELECTION,
);
const listTargetsSuggestedTargetId =
  process.env.FAKE_SIDECAR_SUGGESTED_TARGET_ID;
const listTargetsWarning = process.env.FAKE_SIDECAR_TARGETS_WARNING;
const pushTalkRegisteredOverride = parseBooleanEnv(
  process.env.FAKE_SIDECAR_PUSH_TALK_REGISTERED,
);
const pushMuteRegisteredOverride = parseBooleanEnv(
  process.env.FAKE_SIDECAR_PUSH_MUTE_REGISTERED,
);
const pushKeybindErrors =
  parseStringArrayEnv(process.env.FAKE_SIDECAR_PUSH_KEYBIND_ERRORS) || [];
const emitTalkActiveOnSet = parseBooleanEnv(
  process.env.FAKE_SIDECAR_EMIT_PUSH_TALK_ACTIVE_ON_SET,
);
const emitMuteActiveOnSet = parseBooleanEnv(
  process.env.FAKE_SIDECAR_EMIT_PUSH_MUTE_ACTIVE_ON_SET,
);

const send = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const sendResponse = (id, result) => {
  send({
    id,
    ok: true,
    result,
  });
};

const sendError = (id, message) => {
  send({
    id,
    ok: false,
    error: {
      message,
    },
  });
};

const stopSession = () => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  if (!activeSession) {
    return;
  }

  send({
    event: "audio_capture.ended",
    params: {
      sessionId: activeSession.sessionId,
      targetId: activeSession.targetId,
      reason: "capture_stopped",
      protocolVersion: 1,
    },
  });

  activeSession = null;
};

const startSession = (targetId) => {
  stopSession();

  const sessionId = `session-${Date.now()}`;
  const sampleRate = 48000;
  const channels = 2;
  const frameCount = 960;
  const samples = new Float32Array(frameCount * channels);
  const pcmBase64 = Buffer.from(samples.buffer).toString("base64");
  let sequence = 0;

  activeSession = {
    sessionId,
    targetId,
  };

  intervalId = setInterval(() => {
    send({
      event: "audio_capture.frame",
      params: {
        sessionId,
        targetId,
        sequence: sequence++,
        sampleRate,
        channels,
        frameCount,
        pcmBase64,
        protocolVersion: 1,
        encoding: "f32le_base64",
        droppedFrameCount: 0,
      },
    });
  }, 10);

  return {
    sessionId,
    targetId,
    sampleRate,
    channels,
    framesPerBuffer: frameCount,
    protocolVersion: 1,
    encoding: "f32le_base64",
  };
};

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params = {} } = request;

  if (method === "health.ping") {
    sendResponse(id, {
      status: "ok",
    });
    return;
  }

  if (method === "audio_targets.list") {
    const suggestedTargetId =
      listTargetsSuggestedTargetId !== undefined
        ? listTargetsSuggestedTargetId
        : capabilityPlatform === "linux"
          ? undefined
          : params?.sourceId
            ? "pid:1234"
            : undefined;

    sendResponse(id, {
      targets: [
        {
          id: "pid:1234",
          label: "Fake App (1234)",
          pid: 1234,
          processName: "fake.exe",
        },
      ],
      suggestedTargetId,
      requiresManualSelection:
        listTargetsRequiresManualSelection ??
        (capabilityPlatform === "linux" || suggestedTargetId === undefined),
      warning:
        listTargetsWarning ??
        (capabilityPlatform === "linux"
          ? "Linux per-app audio requires choosing the app that is producing sound."
          : undefined),
    });
    return;
  }

  if (method === "audio_capture.start") {
    const targetId = params?.appAudioTargetId || "pid:1234";
    const session = startSession(targetId);
    sendResponse(id, session);
    return;
  }

  if (method === "audio_capture.stop") {
    stopSession();
    sendResponse(id, {
      stopped: true,
    });
    return;
  }

  if (method === "push_keybinds.set") {
    const talkRegistered =
      pushTalkRegisteredOverride ?? Boolean(params?.pushToTalkKeybind);
    const muteRegistered =
      pushMuteRegisteredOverride ?? Boolean(params?.pushToMuteKeybind);

    sendResponse(id, {
      talkRegistered,
      muteRegistered,
      errors: pushKeybindErrors,
    });

    if (talkRegistered && emitTalkActiveOnSet && params?.pushToTalkKeybind) {
      send({
        event: "push_keybind.state",
        params: {
          kind: "talk",
          active: true,
        },
      });
    }

    if (muteRegistered && emitMuteActiveOnSet && params?.pushToMuteKeybind) {
      send({
        event: "push_keybind.state",
        params: {
          kind: "mute",
          active: true,
        },
      });
    }

    return;
  }

  if (method === "capabilities.get") {
    sendResponse(id, {
      platform: capabilityPlatform,
      systemAudio: capabilitySystemAudio,
      perAppAudio: capabilityPerAppAudio,
      reason: capabilityReason,
      reasonCode: capabilityReasonCode,
      perAppAudioReason: capabilityPerAppAudioReason,
      perAppAudioReasonCode: capabilityPerAppAudioReasonCode,
      sessionType: capabilitySessionType,
      linuxAudioBackend: capabilityLinuxAudioBackend,
      linuxAudioBackendUsesShellOuts: capabilityLinuxAudioBackendUsesShellOuts,
      linuxAudioRuntimeAvailable: capabilityLinuxAudioRuntimeAvailable,
      linuxAudioRuntimeReason: capabilityLinuxAudioRuntimeReason,
      linuxAudioCaptureAvailable: capabilityLinuxAudioCaptureAvailable,
      pipewireRuntimeAvailable: capabilityLinuxAudioRuntimeAvailable,
      pipewireRuntimeReason: capabilityLinuxAudioRuntimeReason,
      pipewireToolsAvailable: capabilityLinuxAudioCaptureAvailable,
      portalAvailable: capabilityPortalAvailable,
      portalReason: capabilityPortalReason,
      portalReasonCode: capabilityPortalReasonCode,
      appAudioTargetEnumerationSupported:
        capabilityAppAudioTargetEnumerationSupported,
      appAudioTargetEnumerationReason:
        capabilityAppAudioTargetEnumerationReason,
      appAudioTargetEnumerationReasonCode:
        capabilityAppAudioTargetEnumerationReasonCode,
      sourceAudioTargetInferenceSupported:
        capabilitySourceAudioTargetInferenceSupported,
      sourceAudioTargetInferenceReason:
        capabilitySourceAudioTargetInferenceReason,
      sourceAudioTargetInferenceReasonCode:
        capabilitySourceAudioTargetInferenceReasonCode,
      globalPushKeybinds: capabilityGlobalPushKeybinds,
      globalPushKeybindsReason: capabilityGlobalPushKeybindsReason,
      globalPushKeybindsReasonCode: capabilityGlobalPushKeybindsReasonCode,
      x11DisplayAvailable: capabilityX11DisplayAvailable,
      x11DisplayReason: capabilityX11DisplayReason,
      x11DisplayReasonCode: capabilityX11DisplayReasonCode,
    });
    return;
  }

  sendError(id, `Unknown method: ${method}`);
});

rl.on("close", () => {
  stopSession();
  process.exit(0);
});

if (crashAfterMs > 0) {
  setTimeout(() => {
    process.exit(1);
  }, crashAfterMs);
}
