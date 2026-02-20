import { contextBridge, ipcRenderer } from "electron";
import type {
  TAppAudioFrame,
  TAppAudioPcmFrame,
  TAppAudioSession,
  TAppAudioStatusEvent,
  TDesktopPushKeybindEvent,
  TDesktopPushKeybindsInput,
  TDesktopUpdateStatus,
  TGlobalPushKeybindRegistrationResult,
  TDesktopAppAudioTargetsResult,
  TScreenShareSelection,
  TStartAppAudioCaptureInput,
  TStartVoiceFilterInput,
  TVoiceFilterFrame,
  TVoiceFilterPcmFrame,
  TVoiceFilterSession,
  TVoiceFilterStatusEvent,
} from "../main/types";

const APP_AUDIO_CHANNEL_INIT_TIMEOUT_MS = 3_000;
const APP_AUDIO_CHANNEL_RECONNECT_BASE_DELAY_MS = 250;
const APP_AUDIO_CHANNEL_RECONNECT_MAX_DELAY_MS = 2_000;
const APP_AUDIO_CHANNEL_WATCHDOG_INTERVAL_MS = 2_000;
const APP_AUDIO_CHANNEL_STALL_TIMEOUT_MS = 8_000;
const VOICE_FILTER_CHANNEL_INIT_TIMEOUT_MS = 3_000;
const VOICE_FILTER_DEBUG_LOG_PREFIX = "[voice-filter-debug]";
const appAudioFrameSubscribers = new Set<
  (frame: TAppAudioFrame | TAppAudioPcmFrame) => void
>();
const activeAppAudioSessionIds = new Set<string>();
let appAudioFrameFallbackBound = false;
let appAudioFramePort: MessagePort | undefined;
let appAudioFramePortPromise: Promise<boolean> | undefined;
let appAudioFrameReconnectTimer: number | undefined;
let appAudioFrameReconnectAttempts = 0;
let appAudioFrameWatchdogTimer: number | undefined;
let appAudioHasReceivedFrameSinceCaptureStart = false;
let appAudioLastFrameAt = 0;
let voiceFilterFramePort: MessagePort | undefined;
let voiceFilterFramePortPromise: Promise<boolean> | undefined;

const encodePcmBase64 = (samples: Float32Array): string => {
  const bytes = new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
};

const toFallbackVoiceFilterFrame = (frame: TVoiceFilterPcmFrame): TVoiceFilterFrame => {
  return {
    sessionId: frame.sessionId,
    sequence: frame.sequence,
    sampleRate: frame.sampleRate,
    channels: frame.channels,
    frameCount: frame.frameCount,
    pcmBase64: encodePcmBase64(frame.pcm),
    protocolVersion: frame.protocolVersion,
    encoding: "f32le_base64",
  };
};

const dispatchAppAudioFrame = (frame: TAppAudioFrame | TAppAudioPcmFrame) => {
  appAudioHasReceivedFrameSinceCaptureStart = true;
  appAudioLastFrameAt = Date.now();

  for (const callback of appAudioFrameSubscribers) {
    callback(frame);
  }
};

const closeAppAudioFramePort = () => {
  if (!appAudioFramePort) {
    return;
  }

  const port = appAudioFramePort;
  appAudioFramePort = undefined;
  port.onmessage = null;
  port.onmessageerror = null;
  try {
    port.close();
  } catch {
    // ignore
  }
};

const clearAppAudioFrameReconnectTimer = () => {
  if (appAudioFrameReconnectTimer === undefined) {
    return;
  }

  window.clearTimeout(appAudioFrameReconnectTimer);
  appAudioFrameReconnectTimer = undefined;
};

const clearAppAudioFrameWatchdog = () => {
  if (appAudioFrameWatchdogTimer === undefined) {
    return;
  }

  window.clearInterval(appAudioFrameWatchdogTimer);
  appAudioFrameWatchdogTimer = undefined;
};

const resetAppAudioCaptureState = () => {
  appAudioHasReceivedFrameSinceCaptureStart = false;
  appAudioLastFrameAt = 0;
};

const ensureAppAudioFrameWatchdog = () => {
  if (activeAppAudioSessionIds.size === 0) {
    clearAppAudioFrameWatchdog();
    resetAppAudioCaptureState();
    return;
  }

  if (appAudioFrameWatchdogTimer !== undefined) {
    return;
  }

  appAudioFrameWatchdogTimer = window.setInterval(() => {
    if (activeAppAudioSessionIds.size === 0) {
      clearAppAudioFrameWatchdog();
      resetAppAudioCaptureState();
      return;
    }

    if (!appAudioHasReceivedFrameSinceCaptureStart || appAudioLastFrameAt <= 0) {
      return;
    }

    const now = Date.now();
    if (now - appAudioLastFrameAt < APP_AUDIO_CHANNEL_STALL_TIMEOUT_MS) {
      return;
    }

    resetAppAudioCaptureState();
    closeAppAudioFramePort();
    scheduleAppAudioFrameChannelReconnect();
  }, APP_AUDIO_CHANNEL_WATCHDOG_INTERVAL_MS);
};

const trackAppAudioCaptureStart = (sessionId: string) => {
  activeAppAudioSessionIds.add(sessionId);
  resetAppAudioCaptureState();
  appAudioLastFrameAt = Date.now();
  ensureAppAudioFrameWatchdog();
};

const trackAppAudioCaptureStop = (sessionId?: string) => {
  if (sessionId) {
    activeAppAudioSessionIds.delete(sessionId);
  } else {
    activeAppAudioSessionIds.clear();
  }

  if (activeAppAudioSessionIds.size === 0) {
    clearAppAudioFrameReconnectTimer();
    appAudioFrameReconnectAttempts = 0;
    clearAppAudioFrameWatchdog();
    resetAppAudioCaptureState();
  }
};

const scheduleAppAudioFrameChannelReconnect = () => {
  if (appAudioFrameSubscribers.size === 0) {
    return;
  }

  if (appAudioFramePort || appAudioFramePortPromise || appAudioFrameReconnectTimer !== undefined) {
    return;
  }

  const delayMs = Math.min(
    APP_AUDIO_CHANNEL_RECONNECT_MAX_DELAY_MS,
    APP_AUDIO_CHANNEL_RECONNECT_BASE_DELAY_MS *
      2 ** Math.max(0, appAudioFrameReconnectAttempts),
  );

  appAudioFrameReconnectTimer = window.setTimeout(() => {
    appAudioFrameReconnectTimer = undefined;
    appAudioFrameReconnectAttempts += 1;

    void ensureAppAudioFrameChannel().then((connected) => {
      if (!connected) {
        scheduleAppAudioFrameChannelReconnect();
      }
    });
  }, delayMs);
};

const bindAppAudioFrameFallbackListener = () => {
  if (appAudioFrameFallbackBound) {
    return;
  }

  appAudioFrameFallbackBound = true;
  ipcRenderer.on(
    "desktop:app-audio-frame",
    (_event: unknown, frame: TAppAudioFrame) => {
      dispatchAppAudioFrame(frame);
      if (!appAudioFramePort && !appAudioFramePortPromise) {
        scheduleAppAudioFrameChannelReconnect();
      }
    },
  );
};

const ensureAppAudioFrameChannel = (): Promise<boolean> => {
  if (appAudioFramePort) {
    return Promise.resolve(true);
  }

  if (appAudioFramePortPromise) {
    return appAudioFramePortPromise;
  }

  appAudioFramePortPromise = new Promise<boolean>((resolve) => {
    let settled = false;

    const onPortReady = (event: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeout);

      const port = (event as { ports?: MessagePort[] }).ports?.[0];
      if (!port) {
        appAudioFramePortPromise = undefined;
        scheduleAppAudioFrameChannelReconnect();
        resolve(false);
        return;
      }

      clearAppAudioFrameReconnectTimer();
      appAudioFrameReconnectAttempts = 0;
      appAudioFramePort = port;
      appAudioFramePort.onmessage = (portEvent) => {
        const data = portEvent.data as
          | {
              sessionId?: unknown;
              targetId?: unknown;
              sequence?: unknown;
              sampleRate?: unknown;
              channels?: unknown;
              frameCount?: unknown;
              protocolVersion?: unknown;
              droppedFrameCount?: unknown;
              pcmBuffer?: unknown;
              pcmByteOffset?: unknown;
              pcmByteLength?: unknown;
            }
          | undefined;

        if (!data || typeof data !== "object") {
          return;
        }

        const {
          sessionId,
          targetId,
          sequence,
          sampleRate,
          channels,
          frameCount,
          protocolVersion,
          droppedFrameCount,
          pcmBuffer,
          pcmByteOffset,
          pcmByteLength,
        } = data;

        if (
          typeof sessionId !== "string" ||
          typeof targetId !== "string" ||
          typeof sequence !== "number" ||
          typeof sampleRate !== "number" ||
          typeof channels !== "number" ||
          typeof frameCount !== "number" ||
          typeof protocolVersion !== "number" ||
          !(pcmBuffer instanceof ArrayBuffer)
        ) {
          return;
        }

        if (
          !Number.isInteger(sequence) ||
          sequence < 0 ||
          !Number.isInteger(sampleRate) ||
          sampleRate <= 0 ||
          !Number.isInteger(channels) ||
          channels <= 0 ||
          !Number.isInteger(frameCount) ||
          frameCount <= 0
        ) {
          return;
        }

        const byteOffset =
          typeof pcmByteOffset === "number" && Number.isInteger(pcmByteOffset)
            ? pcmByteOffset
            : 0;
        const byteLength =
          typeof pcmByteLength === "number" && Number.isInteger(pcmByteLength)
            ? pcmByteLength
            : pcmBuffer.byteLength;

        if (
          byteOffset < 0 ||
          byteLength <= 0 ||
          byteOffset + byteLength > pcmBuffer.byteLength ||
          byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
        ) {
          return;
        }

        const actualSampleCount = byteLength / Float32Array.BYTES_PER_ELEMENT;
        const expectedSampleCount = frameCount * channels;
        if (actualSampleCount !== expectedSampleCount) {
          return;
        }

        const frame: TAppAudioPcmFrame = {
          sessionId,
          targetId,
          sequence,
          sampleRate,
          channels,
          frameCount,
          protocolVersion,
          droppedFrameCount:
            typeof droppedFrameCount === "number" ? droppedFrameCount : undefined,
          pcm: new Float32Array(
            pcmBuffer,
            byteOffset,
            byteLength / Float32Array.BYTES_PER_ELEMENT,
          ),
        };

        dispatchAppAudioFrame(frame);
      };
      appAudioFramePort.onmessageerror = () => {
        closeAppAudioFramePort();
        scheduleAppAudioFrameChannelReconnect();
      };

      try {
        appAudioFramePort.start();
      } catch {
        // ignore unsupported start() implementations
      }

      appAudioFramePortPromise = undefined;
      resolve(true);
    };

    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      ipcRenderer.removeListener(
        "desktop:app-audio-frame-channel-ready",
        onPortReady,
      );
      appAudioFramePortPromise = undefined;
      scheduleAppAudioFrameChannelReconnect();
      resolve(false);
    }, APP_AUDIO_CHANNEL_INIT_TIMEOUT_MS);

    ipcRenderer.once("desktop:app-audio-frame-channel-ready", onPortReady);
    ipcRenderer.send("desktop:open-app-audio-frame-channel");
  });

  return appAudioFramePortPromise;
};

const ensureVoiceFilterFrameChannel = (): Promise<boolean> => {
  if (voiceFilterFramePort) {
    return Promise.resolve(true);
  }

  if (voiceFilterFramePortPromise) {
    return voiceFilterFramePortPromise;
  }

  voiceFilterFramePortPromise = new Promise<boolean>((resolve) => {
    let settled = false;
    const onPortReady = (event: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeout);

      const port = (event as { ports?: MessagePort[] }).ports?.[0];
      if (!port) {
        voiceFilterFramePortPromise = undefined;
        resolve(false);
        return;
      }

      voiceFilterFramePort = port;
      voiceFilterFramePort.onmessageerror = () => {
        console.warn(
          `${VOICE_FILTER_DEBUG_LOG_PREFIX} Voice-filter MessagePort message error; resetting channel`,
        );
        voiceFilterFramePort = undefined;
      };

      try {
        voiceFilterFramePort.start();
      } catch {
        // ignore unsupported start() implementations
      }

      console.warn(`${VOICE_FILTER_DEBUG_LOG_PREFIX} Voice-filter MessagePort ready`);

      voiceFilterFramePortPromise = undefined;
      resolve(true);
    };

    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      ipcRenderer.removeListener(
        "desktop:voice-filter-frame-channel-ready",
        onPortReady,
      );
      voiceFilterFramePortPromise = undefined;
      console.warn(
        `${VOICE_FILTER_DEBUG_LOG_PREFIX} Timed out waiting for voice-filter MessagePort`,
      );
      resolve(false);
    }, VOICE_FILTER_CHANNEL_INIT_TIMEOUT_MS);
    ipcRenderer.once("desktop:voice-filter-frame-channel-ready", onPortReady);

    ipcRenderer.send("desktop:open-voice-filter-frame-channel");
  });

  return voiceFilterFramePortPromise;
};

const desktopBridge = {
  getServerUrl: (): Promise<string> =>
    ipcRenderer.invoke("desktop:get-server-url"),
  setServerUrl: (serverUrl: string): Promise<void> =>
    ipcRenderer.invoke("desktop:set-server-url", serverUrl),
  getCapabilities: () => ipcRenderer.invoke("desktop:get-capabilities"),
  pingSidecar: () => ipcRenderer.invoke("desktop:ping-sidecar"),
  getUpdateStatus: (): Promise<TDesktopUpdateStatus> =>
    ipcRenderer.invoke("desktop:get-update-status"),
  checkForUpdates: (): Promise<TDesktopUpdateStatus> =>
    ipcRenderer.invoke("desktop:check-for-updates"),
  installUpdateAndRestart: (): Promise<boolean> =>
    ipcRenderer.invoke("desktop:install-update-and-restart"),
  listShareSources: () => ipcRenderer.invoke("desktop:list-share-sources"),
  listAppAudioTargets: (sourceId?: string): Promise<TDesktopAppAudioTargetsResult> =>
    ipcRenderer.invoke("desktop:list-app-audio-targets", sourceId),
  startAppAudioCapture: (input: TStartAppAudioCaptureInput): Promise<TAppAudioSession> =>
    ipcRenderer
      .invoke("desktop:start-app-audio-capture", input)
      .then((session: TAppAudioSession) => {
        trackAppAudioCaptureStart(session.sessionId);
        clearAppAudioFrameReconnectTimer();
        void ensureAppAudioFrameChannel().then((connected) => {
          if (!connected) {
            scheduleAppAudioFrameChannelReconnect();
          }
        });
        return session;
      }),
  stopAppAudioCapture: (sessionId?: string): Promise<void> =>
    ipcRenderer.invoke("desktop:stop-app-audio-capture", sessionId).finally(() => {
      trackAppAudioCaptureStop(sessionId);
    }),
  startVoiceFilterSession: (
    input: TStartVoiceFilterInput,
  ): Promise<TVoiceFilterSession> =>
    ipcRenderer.invoke("desktop:start-voice-filter-session", input),
  stopVoiceFilterSession: (sessionId?: string): Promise<void> =>
    ipcRenderer.invoke("desktop:stop-voice-filter-session", sessionId),
  ensureVoiceFilterFrameChannel: (): Promise<boolean> =>
    ensureVoiceFilterFrameChannel(),
  setGlobalPushKeybinds: (
    input: TDesktopPushKeybindsInput,
  ): Promise<TGlobalPushKeybindRegistrationResult> =>
    ipcRenderer.invoke("desktop:set-global-push-keybinds", input),
  pushVoiceFilterPcmFrame: (frame: TVoiceFilterPcmFrame): void => {
    if (voiceFilterFramePort) {
      const { pcm } = frame;
      try {
        const pcmCopy = new Float32Array(pcm.length);
        pcmCopy.set(pcm);

        voiceFilterFramePort.postMessage(
          {
            sessionId: frame.sessionId,
            sequence: frame.sequence,
            sampleRate: frame.sampleRate,
            channels: frame.channels,
            frameCount: frame.frameCount,
            protocolVersion: frame.protocolVersion,
            pcmSamples: pcmCopy,
          },
        );
        return;
      } catch {
        console.warn(
          `${VOICE_FILTER_DEBUG_LOG_PREFIX} Failed to post PCM frame via MessagePort; switching to JSON fallback`,
        );
        voiceFilterFramePort = undefined;
      }
    }

    void ensureVoiceFilterFrameChannel();
    ipcRenderer.send(
      "desktop:push-voice-filter-frame",
      toFallbackVoiceFilterFrame(frame),
    );
  },
  pushVoiceFilterFrame: (frame: TVoiceFilterFrame): void => {
    ipcRenderer.send("desktop:push-voice-filter-frame", frame);
  },
  subscribeAppAudioFrames: (
    callback: (frame: TAppAudioFrame | TAppAudioPcmFrame) => void,
  ) => {
    appAudioFrameSubscribers.add(callback);
    bindAppAudioFrameFallbackListener();
    clearAppAudioFrameReconnectTimer();
    void ensureAppAudioFrameChannel().then((connected) => {
      if (!connected) {
        scheduleAppAudioFrameChannelReconnect();
      }
    });

    return () => {
      appAudioFrameSubscribers.delete(callback);
      if (appAudioFrameSubscribers.size === 0) {
        clearAppAudioFrameReconnectTimer();
        appAudioFrameReconnectAttempts = 0;
      }
    };
  },
  subscribeAppAudioStatus: (
    callback: (statusEvent: TAppAudioStatusEvent) => void,
  ) => {
    const listener = (_event: unknown, statusEvent: TAppAudioStatusEvent) => {
      trackAppAudioCaptureStop(statusEvent.sessionId);
      callback(statusEvent);
    };

    ipcRenderer.on("desktop:app-audio-status", listener);

    return () => {
      ipcRenderer.removeListener("desktop:app-audio-status", listener);
    };
  },
  subscribeVoiceFilterFrames: (callback: (frame: TVoiceFilterFrame) => void) => {
    const listener = (_event: unknown, frame: TVoiceFilterFrame) => {
      callback(frame);
    };

    ipcRenderer.on("desktop:voice-filter-frame", listener);

    return () => {
      ipcRenderer.removeListener("desktop:voice-filter-frame", listener);
    };
  },
  subscribeVoiceFilterStatus: (
    callback: (statusEvent: TVoiceFilterStatusEvent) => void,
  ) => {
    const listener = (_event: unknown, statusEvent: TVoiceFilterStatusEvent) => {
      callback(statusEvent);
    };

    ipcRenderer.on("desktop:voice-filter-status", listener);

    return () => {
      ipcRenderer.removeListener("desktop:voice-filter-status", listener);
    };
  },
  subscribeGlobalPushKeybindEvents: (
    callback: (event: TDesktopPushKeybindEvent) => void,
  ) => {
    const listener = (_ipcEvent: unknown, event: TDesktopPushKeybindEvent) => {
      callback(event);
    };

    ipcRenderer.on("desktop:global-push-keybind", listener);

    return () => {
      ipcRenderer.removeListener("desktop:global-push-keybind", listener);
    };
  },
  subscribeUpdateStatus: (callback: (status: TDesktopUpdateStatus) => void) => {
    const listener = (_event: unknown, status: TDesktopUpdateStatus) => {
      callback(status);
    };

    ipcRenderer.on("desktop:update-status", listener);

    return () => {
      ipcRenderer.removeListener("desktop:update-status", listener);
    };
  },
  prepareScreenShare: (selection: TScreenShareSelection) =>
    ipcRenderer.invoke("desktop:prepare-screen-share", selection),
};

contextBridge.exposeInMainWorld("sharkordDesktop", desktopBridge);
