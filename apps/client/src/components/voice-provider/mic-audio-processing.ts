import { getDesktopBridge } from '@/runtime/desktop-bridge';
import type {
  TDesktopBridge,
  TVoiceFilterFrame,
  TVoiceFilterFrameDiag,
  TVoiceFilterStatusEvent,
  TVoiceFilterStrength as TRuntimeVoiceFilterStrength
} from '@/runtime/types';
import { VoiceFilterStrength } from '@/types';
import { createDesktopAppAudioPipeline } from './desktop-app-audio';
import micCaptureWorkletModuleUrl from './mic-capture.worklet.js?url&no-inline';

// ---------------------------------------------------------------------------
// NC diagnostics aggregator
// ---------------------------------------------------------------------------
// Accumulates per-frame diagnostics from the sidecar and logs a rolling
// summary every NC_DIAG_LOG_INTERVAL_MS.  The latest snapshot is also
// exposed on window.ncDiagnostics for manual inspection in DevTools.
// ---------------------------------------------------------------------------

const NC_DIAG_LOG_INTERVAL_MS = 5_000;
const NC_DIAG_WINDOW_SIZE = 500; // frames (~5 s at 10 ms/frame)

type TNcDiagSnapshot = {
  sessionId: string;
  frameCount: number;
  lsnrMean: number | null;
  lsnrMin: number | null;
  lsnrMax: number | null;
  gateGainMean: number;
  agcGainMean: number | null;
  /** How many frames had the startup ramp still active (rampWetMix < 1). */
  rampActiveFrames: number;
  droppedFrames: number;
  timestampMs: number;
};

declare global {
  interface Window {
    ncDiagnostics: TNcDiagSnapshot | null;
  }
}

window.ncDiagnostics = null;

const createNcDiagnosticsAggregator = (sessionId: string) => {
  const lsnrValues: number[] = [];
  const gateGainValues: number[] = [];
  const agcGainValues: number[] = [];
  let rampActiveFrames = 0;
  let totalDropped = 0;
  let totalFrames = 0;
  let lastLogTime = Date.now();

  const push = (frame: TVoiceFilterFrame) => {
    totalFrames++;
    if (frame.droppedFrameCount) totalDropped += frame.droppedFrameCount;

    const d: TVoiceFilterFrameDiag | undefined = frame.diag;
    if (!d) return;

    if (d.lsnrMean !== undefined) {
      lsnrValues.push(d.lsnrMean);
      if (lsnrValues.length > NC_DIAG_WINDOW_SIZE) lsnrValues.shift();
    }

    gateGainValues.push(d.gateGain);
    if (gateGainValues.length > NC_DIAG_WINDOW_SIZE) gateGainValues.shift();

    if (d.agcGain !== undefined) {
      agcGainValues.push(d.agcGain);
      if (agcGainValues.length > NC_DIAG_WINDOW_SIZE) agcGainValues.shift();
    }

    if (d.rampWetMix < 1.0) rampActiveFrames++;

    const now = Date.now();
    if (now - lastLogTime >= NC_DIAG_LOG_INTERVAL_MS) {
      lastLogTime = now;
      logSnapshot();
    }
  };

  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  const logSnapshot = () => {
    const snapshot: TNcDiagSnapshot = {
      sessionId,
      frameCount: totalFrames,
      lsnrMean: avg(lsnrValues),
      lsnrMin: lsnrValues.length > 0 ? Math.min(...lsnrValues) : null,
      lsnrMax: lsnrValues.length > 0 ? Math.max(...lsnrValues) : null,
      gateGainMean: avg(gateGainValues) ?? 1,
      agcGainMean: avg(agcGainValues),
      rampActiveFrames,
      droppedFrames: totalDropped,
      timestampMs: Date.now()
    };

    window.ncDiagnostics = snapshot;

    const lsnr = snapshot.lsnrMean !== null ? snapshot.lsnrMean.toFixed(1) : 'n/a';
    const lsnrRange =
      snapshot.lsnrMin !== null && snapshot.lsnrMax !== null
        ? `[${snapshot.lsnrMin.toFixed(1)}, ${snapshot.lsnrMax.toFixed(1)}]`
        : 'n/a';
    const gate = snapshot.gateGainMean.toFixed(2);
    const agc =
      snapshot.agcGainMean !== null ? `${snapshot.agcGainMean.toFixed(2)}×` : 'off';

    console.warn(
      `[nc-diag] lsnr=${lsnr} dB range=${lsnrRange} gate=${gate} agc=${agc}` +
        ` rampFrames=${snapshot.rampActiveFrames} dropped=${snapshot.droppedFrames}` +
        ` frames=${snapshot.frameCount}`
    );
  };

  return { push };
};

type TMicAudioProcessingBackend = 'sidecar-native';

type TMicAudioProcessingPipeline = {
  sessionId: string;
  sampleRate: number;
  channels: number;
  framesPerBuffer: number;
  stream: MediaStream;
  track: MediaStreamTrack;
  backend: TMicAudioProcessingBackend;
  destroy: () => Promise<void>;
};

type TCreateMicAudioProcessingPipelineInput = {
  inputTrack: MediaStreamTrack;
  enabled: boolean;
  suppressionLevel: VoiceFilterStrength;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  echoCancellation: boolean;
  sidecarDeviceId?: string;
};

const MIC_CAPTURE_WORKLET_NAME = 'sharkord-mic-capture-processor';
const FIRST_FILTERED_FRAME_TIMEOUT_MS = 4_000;

const ensureMicCaptureWorkletModule = async (audioContext: AudioContext) => {
  await audioContext.audioWorklet.addModule(micCaptureWorkletModuleUrl);
};

const resolveInputChannelCount = (track: MediaStreamTrack): number => {
  const channelCount = track.getSettings().channelCount;
  if (typeof channelCount !== 'number' || !Number.isFinite(channelCount)) {
    return 1;
  }

  return Math.max(1, Math.min(2, Math.floor(channelCount)));
};

const createNativeDesktopMicAudioProcessingPipeline = async ({
  inputTrack,
  channels,
  suppressionLevel,
  noiseSuppression,
  autoGainControl,
  echoCancellation
}: {
  inputTrack: MediaStreamTrack;
  channels: number;
  suppressionLevel: VoiceFilterStrength;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  echoCancellation: boolean;
}): Promise<TMicAudioProcessingPipeline | undefined> => {
  const desktopBridge = getDesktopBridge();

  if (!desktopBridge) {
    return undefined;
  }

  const session = await desktopBridge.startVoiceFilterSession({
    sampleRate: 48_000,
    channels,
    suppressionLevel: suppressionLevel as unknown as TRuntimeVoiceFilterStrength,
    noiseSuppression,
    autoGainControl,
    echoCancellation
  });
  console.log('[voice-filter-debug] Started native voice-filter session', {
    sessionId: session.sessionId,
    sampleRate: session.sampleRate,
    channels: session.channels,
    framesPerBuffer: session.framesPerBuffer,
    protocolVersion: session.protocolVersion
  });

  const outputPipeline = await createDesktopAppAudioPipeline({
    sessionId: session.sessionId,
    targetId: 'native-mic-filter',
    sampleRate: session.sampleRate,
    channels: session.channels,
    framesPerBuffer: session.framesPerBuffer,
    protocolVersion: session.protocolVersion,
    encoding: session.encoding
  }, {
    mode: 'stable',
    logLabel: 'mic-voice-filter',
    insertSilenceOnDroppedFrames: true
  });

  const AudioContextClass =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioContextClass) {
    await outputPipeline.destroy();
    await desktopBridge.stopVoiceFilterSession(session.sessionId);
    return undefined;
  }

  const captureContext = new AudioContextClass({
    sampleRate: session.sampleRate
  });
  const captureInputStream = new MediaStream([inputTrack]);
  const sourceNode = captureContext.createMediaStreamSource(captureInputStream);
  const targetFrameSize = Math.max(1, Math.floor(session.framesPerBuffer || 480));
  let workletNode: AudioWorkletNode;
  const sinkNode = captureContext.createGain();
  sinkNode.gain.value = 0;
  let hasReceivedFilteredFrame = false;
  let settleFirstFilteredFrame: ((error?: Error) => void) | undefined;
  const firstFilteredFramePromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(
        new Error(`Native voice filter produced no frames (session=${session.sessionId})`)
      );
    }, FIRST_FILTERED_FRAME_TIMEOUT_MS);

    settleFirstFilteredFrame = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeout);

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };
  });

  let sequence = 0;
  let hasSentInputFrame = false;

  const ncDiag = createNcDiagnosticsAggregator(session.sessionId);

  const removeFrameSubscription = desktopBridge.subscribeVoiceFilterFrames(
    (frame: TVoiceFilterFrame) => {
      if (frame.sessionId !== session.sessionId) {
        return;
      }

      ncDiag.push(frame);

      outputPipeline.pushFrame({
        ...frame,
        targetId: 'native-mic-filter'
      });

      if (!hasReceivedFilteredFrame) {
        hasReceivedFilteredFrame = true;
        console.log('[voice-filter-debug] Received first processed voice-filter frame', {
          sessionId: frame.sessionId,
          sequence: frame.sequence,
          frameCount: frame.frameCount,
          channels: frame.channels
        });
        settleFirstFilteredFrame?.();
      }
    }
  );

  const removeStatusSubscription = desktopBridge.subscribeVoiceFilterStatus(
    (statusEvent: TVoiceFilterStatusEvent) => {
      if (statusEvent.sessionId !== session.sessionId) {
        return;
      }

      if (statusEvent.reason !== 'capture_stopped') {
        console.log('[voice-filter] Native voice filter session ended', statusEvent);
        if (statusEvent.error) {
          console.warn(
            '[voice-filter-debug] Native voice filter status error detail',
            statusEvent.error
          );
        }
      }

      if (!hasReceivedFilteredFrame) {
        settleFirstFilteredFrame?.(
          new Error(`Native voice filter ended before frames (${statusEvent.reason})`)
        );
      }
    }
  );

  const pushInterleavedPcmFrame = (samples: Float32Array, frameCount: number) => {
    if (frameCount <= 0) {
      return;
    }

    if (!hasSentInputFrame) {
      hasSentInputFrame = true;
      console.log('[voice-filter-debug] Sending first PCM frame to sidecar', {
        sessionId: session.sessionId,
        sequence,
        frameCount,
        channels: session.channels,
        sampleRate: session.sampleRate
      });
    }

    desktopBridge.pushVoiceFilterPcmFrame({
      sessionId: session.sessionId,
      sequence,
      sampleRate: session.sampleRate,
      channels: session.channels,
      frameCount,
      pcm: samples,
      protocolVersion: 1
    });

    sequence += 1;
  };

  if (
    typeof AudioWorkletNode === 'undefined' ||
    typeof captureContext.audioWorklet === 'undefined'
  ) {
    await outputPipeline.destroy();
    await desktopBridge.stopVoiceFilterSession(session.sessionId);
    await captureContext.close();
    throw new Error('AudioWorklet mic capture is unavailable');
  }

  try {
    await ensureMicCaptureWorkletModule(captureContext);

    workletNode = new AudioWorkletNode(captureContext, MIC_CAPTURE_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [session.channels],
      processorOptions: {
        channels: session.channels,
        targetFrameSize
      }
    });
  } catch (error) {
    await outputPipeline.destroy();
    await desktopBridge.stopVoiceFilterSession(session.sessionId);
    await captureContext.close();
    throw error;
  }

  workletNode.port.onmessage = (messageEvent) => {
    const data = messageEvent.data;
    if (!data || data.type !== 'pcm' || !data.samples) {
      return;
    }

    const samples = data.samples as Float32Array;
    const frameCount =
      typeof data.frameCount === 'number'
        ? Math.floor(data.frameCount)
        : Math.floor(samples.length / session.channels);

    pushInterleavedPcmFrame(samples, frameCount);
  };

  sourceNode.connect(workletNode);
  workletNode.connect(sinkNode);

  sinkNode.connect(captureContext.destination);

  void desktopBridge.ensureVoiceFilterFrameChannel();

  if (captureContext.state !== 'running') {
    await captureContext.resume();
  }

  const pipeline: TMicAudioProcessingPipeline = {
    sessionId: session.sessionId,
    sampleRate: session.sampleRate,
    channels: session.channels,
    framesPerBuffer: targetFrameSize,
    stream: outputPipeline.stream,
    track: outputPipeline.track,
    backend: 'sidecar-native',
    destroy: async () => {
      try {
        workletNode.port.onmessage = null;
        workletNode.port.postMessage({
          type: 'reset'
        });
      } catch {
        // ignore
      }

      removeFrameSubscription();
      removeStatusSubscription();

      try {
        sourceNode.disconnect();
      } catch {
        // ignore
      }

      try {
        workletNode.disconnect();
      } catch {
        // ignore
      }

      try {
        sinkNode.disconnect();
      } catch {
        // ignore
      }

      await desktopBridge.stopVoiceFilterSession(session.sessionId);
      await outputPipeline.destroy();
      await captureContext.close();
    }
  };

  try {
    await firstFilteredFramePromise;
  } catch (error) {
    await pipeline.destroy();
    throw error;
  }

  return pipeline;
};

const createNativeSidecarMicCapturePipeline = async ({
  suppressionLevel,
  noiseSuppression,
  autoGainControl,
  echoCancellation,
  sidecarDeviceId,
  desktopBridge
}: {
  suppressionLevel: VoiceFilterStrength;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  echoCancellation: boolean;
  sidecarDeviceId: string | undefined;
  desktopBridge: TDesktopBridge;
}): Promise<TMicAudioProcessingPipeline | undefined> => {
  const session = await desktopBridge.startVoiceFilterSessionWithCapture({
    sampleRate: 48_000,
    channels: 2,
    suppressionLevel: suppressionLevel as unknown as TRuntimeVoiceFilterStrength,
    noiseSuppression,
    autoGainControl,
    echoCancellation,
    deviceId: sidecarDeviceId
  });
  console.log('[voice-filter-debug] Started native sidecar mic-capture session', session);

  const outputPipeline = await createDesktopAppAudioPipeline({
    sessionId: session.sessionId,
    targetId: 'native-mic-filter',
    sampleRate: session.sampleRate,
    channels: session.channels,
    framesPerBuffer: session.framesPerBuffer,
    protocolVersion: session.protocolVersion,
    encoding: session.encoding
  }, {
    mode: 'stable',
    logLabel: 'mic-voice-filter',
    insertSilenceOnDroppedFrames: true
  });

  let hasReceivedFilteredFrame = false;
  let settleFirstFilteredFrame: ((error?: Error) => void) | undefined;
  const firstFilteredFramePromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Native sidecar mic-capture produced no frames (session=${session.sessionId})`));
    }, FIRST_FILTERED_FRAME_TIMEOUT_MS);

    settleFirstFilteredFrame = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
  });

  const ncDiag = createNcDiagnosticsAggregator(session.sessionId);

  const removeFrameSubscription = desktopBridge.subscribeVoiceFilterFrames(
    (frame: TVoiceFilterFrame) => {
      if (frame.sessionId !== session.sessionId) return;

      ncDiag.push(frame);

      outputPipeline.pushFrame({ ...frame, targetId: 'native-mic-filter' });

      if (!hasReceivedFilteredFrame) {
        hasReceivedFilteredFrame = true;
        console.log('[voice-filter-debug] Received first processed voice-filter frame', {
          sessionId: frame.sessionId,
          sequence: frame.sequence,
          frameCount: frame.frameCount,
          channels: frame.channels
        });
        settleFirstFilteredFrame?.();
      }
    }
  );

  const removeStatusSubscription = desktopBridge.subscribeVoiceFilterStatus(
    (statusEvent: TVoiceFilterStatusEvent) => {
      if (statusEvent.sessionId !== session.sessionId) return;

      if (statusEvent.reason !== 'capture_stopped') {
        console.log('[voice-filter] Native sidecar mic-capture session ended', statusEvent);
        if (statusEvent.error) {
          console.warn('[voice-filter-debug] Native sidecar mic-capture error detail', statusEvent.error);
        }
      }

      if (!hasReceivedFilteredFrame) {
        settleFirstFilteredFrame?.(
          new Error(`Native sidecar mic-capture ended before frames (${statusEvent.reason})`)
        );
      }
    }
  );

  const pipeline: TMicAudioProcessingPipeline = {
    sessionId: session.sessionId,
    sampleRate: session.sampleRate,
    channels: session.channels,
    framesPerBuffer: session.framesPerBuffer,
    stream: outputPipeline.stream,
    track: outputPipeline.track,
    backend: 'sidecar-native',
    destroy: async () => {
      removeFrameSubscription();
      removeStatusSubscription();
      await desktopBridge.stopVoiceFilterSession(session.sessionId);
      await outputPipeline.destroy();
    }
  };

  try {
    await firstFilteredFramePromise;
  } catch (error) {
    await pipeline.destroy();
    throw error;
  }

  return pipeline;
};

const createMicAudioProcessingPipeline = async ({
  inputTrack,
  enabled,
  suppressionLevel,
  noiseSuppression,
  autoGainControl,
  echoCancellation
}: TCreateMicAudioProcessingPipelineInput): Promise<
  TMicAudioProcessingPipeline | undefined
> => {
  if (!enabled) {
    return undefined;
  }

  const channels = resolveInputChannelCount(inputTrack);

  try {
    return await createNativeDesktopMicAudioProcessingPipeline({
      inputTrack,
      channels,
      suppressionLevel,
      noiseSuppression,
      autoGainControl,
      echoCancellation
    });
  } catch (error) {
    if (noiseSuppression) {
      try {
        const fallbackPipeline = await createNativeDesktopMicAudioProcessingPipeline({
          inputTrack,
          channels,
          suppressionLevel,
          noiseSuppression: false,
          autoGainControl,
          echoCancellation
        });

        if (fallbackPipeline) {
          console.warn(
            '[voice-filter] Native filter fallback enabled without DeepFilter noise suppression'
          );
          return fallbackPipeline;
        }
      } catch (fallbackError) {
        console.warn(
          '[voice-filter] Native filter fallback (passthrough) failed, using raw mic',
          fallbackError
        );
      }
    }

    console.warn(
      '[voice-filter] Native desktop voice filter unavailable, using raw mic',
      error
    );
    return undefined;
  }
};

// Matches a browser deviceId to a WASAPI device ID by comparing friendly names.
// Best-effort — returns undefined on any failure so callers fall back to the
// default capture device.
const resolveSidecarDeviceId = async (
  browserDeviceId: string | undefined,
  desktopBridge: TDesktopBridge
): Promise<string | undefined> => {
  try {
    const [browserDevices, sidecarResult] = await Promise.all([
      navigator.mediaDevices.enumerateDevices(),
      desktopBridge.listMicDevices()
    ]);
    const browserLabel = browserDevices
      .find((d) => d.deviceId === browserDeviceId)
      ?.label?.trim()
      .toLowerCase();
    if (!browserLabel) return undefined;
    return sidecarResult.devices.find(
      (d) => d.label.trim().toLowerCase() === browserLabel
    )?.id;
  } catch {
    return undefined;
  }
};

export {
  createMicAudioProcessingPipeline,
  createNativeSidecarMicCapturePipeline,
  resolveSidecarDeviceId
};
export type { TMicAudioProcessingBackend, TMicAudioProcessingPipeline };
