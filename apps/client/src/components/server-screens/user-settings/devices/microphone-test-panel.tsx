import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  createNativeSidecarMicCapturePipeline,
  resolveSidecarDeviceId,
  type TMicAudioProcessingPipeline
} from '@/components/voice-provider/mic-audio-processing';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { updateOwnVoiceState } from '@/features/server/voice/actions';
import { useOwnVoiceState, useVoice } from '@/features/server/voice/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import {
  MicQualityMode,
  VoiceFilterStrength,
  getStrengthDefaults
} from '@/types';
import { Circle, Mic, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

const ANALYSER_FFT_SIZE = 512;
const ANALYSER_SMOOTHING = 0.8;
const LEVEL_FLOOR = 0;
const LEVEL_CEILING = 100;
const RMS_NORMALIZATION = 0.3;
const PREFERRED_RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4'
];

type TMicrophoneTestPanelProps = {
  microphoneId: string | undefined;
  micQualityMode: MicQualityMode;
  voiceFilterStrength: VoiceFilterStrength;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  hasDesktopBridge: boolean;
};

type TResolvedMicTestProcessingConfig = {
  sidecarVoiceProcessingEnabled: boolean;
  browserAutoGainControl: boolean;
  browserNoiseSuppression: boolean;
  browserEchoCancellation: boolean;
  sidecarNoiseSuppression: boolean;
  sidecarAutoGainControl: boolean;
  sidecarEchoCancellation: boolean;
  sidecarSuppressionLevel: VoiceFilterStrength;
  sidecarDfnMix: number;
  sidecarDfnAttenuationLimitDb?: number;
  sidecarExperimentalAggressiveMode: boolean;
  sidecarNoiseGateFloorDbfs?: number;
};

const resolveMicTestProcessingConfig = ({
  micQualityMode,
  hasDesktopBridge,
  voiceFilterStrength,
  echoCancellation,
  noiseSuppression,
  autoGainControl
}: {
  micQualityMode: MicQualityMode;
  hasDesktopBridge: boolean;
  voiceFilterStrength: VoiceFilterStrength;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}): TResolvedMicTestProcessingConfig => {
  const defaults = getStrengthDefaults(voiceFilterStrength);

  if (micQualityMode === MicQualityMode.EXPERIMENTAL) {
    return {
      sidecarVoiceProcessingEnabled: hasDesktopBridge,
      browserAutoGainControl: false,
      browserNoiseSuppression: false,
      browserEchoCancellation: false,
      sidecarNoiseSuppression: noiseSuppression,
      sidecarAutoGainControl: autoGainControl,
      sidecarEchoCancellation: echoCancellation,
      sidecarSuppressionLevel: voiceFilterStrength,
      sidecarDfnMix: defaults.dfnMix,
      sidecarDfnAttenuationLimitDb: defaults.dfnAttenuationLimitDb,
      sidecarExperimentalAggressiveMode: defaults.dfnExperimentalAggressiveMode,
      sidecarNoiseGateFloorDbfs: defaults.dfnNoiseGateFloorDbfs
    };
  }

  // Standard (AUTO) and legacy MANUAL — browser-only, no sidecar.
  // Echo cancellation is forced off for the test: the monitor plays your mic
  // back through speakers, which the browser AEC would treat as echo and cancel,
  // making the playback sound broken.
  return {
    sidecarVoiceProcessingEnabled: false,
    browserAutoGainControl: autoGainControl,
    browserNoiseSuppression: noiseSuppression,
    browserEchoCancellation: false,
    sidecarNoiseSuppression: noiseSuppression,
    sidecarAutoGainControl: autoGainControl,
    sidecarEchoCancellation: false,
    sidecarSuppressionLevel: voiceFilterStrength,
    sidecarDfnMix: defaults.dfnMix,
    sidecarDfnAttenuationLimitDb: defaults.dfnAttenuationLimitDb,
    sidecarExperimentalAggressiveMode: defaults.dfnExperimentalAggressiveMode,
    sidecarNoiseGateFloorDbfs: defaults.dfnNoiseGateFloorDbfs
  };
};

const MicrophoneTestPanel = memo(
  ({
    microphoneId,
    micQualityMode,
    voiceFilterStrength,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    hasDesktopBridge
  }: TMicrophoneTestPanelProps) => {
    const currentVoiceChannelId = useCurrentVoiceChannelId();
    const { localAudioStream } = useVoice();
    const ownVoiceState = useOwnVoiceState();
    const [isTestingMic, setIsTestingMic] = useState(false);
    const [monitorEnabled, setMonitorEnabled] = useState(false);
    const levelBarRef = useRef<HTMLDivElement>(null);
    const [micTestError, setMicTestError] = useState<string | undefined>(
      undefined
    );
    const [isRecordingClip, setIsRecordingClip] = useState(false);
    const [testUsesSidecar, setTestUsesSidecar] = useState(false);
    const [testUsesInCallStream, setTestUsesInCallStream] = useState(false);
    const [recordingError, setRecordingError] = useState<string | undefined>(
      undefined
    );
    const [recordedClipUrl, setRecordedClipUrl] = useState<string | undefined>(
      undefined
    );
    const rawStreamRef = useRef<MediaStream | undefined>(undefined);
    const outputStreamRef = useRef<MediaStream | undefined>(undefined);
    const audioContextRef = useRef<AudioContext | undefined>(undefined);
    const analyserRef = useRef<AnalyserNode | undefined>(undefined);
    const monitorGainNodeRef = useRef<GainNode | undefined>(undefined);
    const animationFrameRef = useRef<number | undefined>(undefined);
    const runVersionRef = useRef(0);
    const micAudioPipelineRef = useRef<TMicAudioProcessingPipeline | undefined>(
      undefined
    );
    const mediaRecorderRef = useRef<MediaRecorder | undefined>(undefined);
    const recordingTimeoutRef = useRef<number | undefined>(undefined);
    const recordingChunksRef = useRef<BlobPart[]>([]);
    const recordingStopPromiseRef = useRef<Promise<void> | undefined>(
      undefined
    );
    const recordingStopResolveRef = useRef<(() => void) | undefined>(undefined);
    const recordedClipUrlRef = useRef<string | undefined>(undefined);
    const micMutedRef = useRef(ownVoiceState.micMuted);
    const soundMutedRef = useRef(ownVoiceState.soundMuted);
    const micMutedBeforeTestRef = useRef<boolean | undefined>(undefined);
    const soundMutedBeforeTestRef = useRef<boolean | undefined>(undefined);
    const resolvedMicProcessingConfig = useMemo(() => {
      return resolveMicTestProcessingConfig({
        micQualityMode,
        hasDesktopBridge,
        voiceFilterStrength,
        echoCancellation,
        noiseSuppression,
        autoGainControl
      });
    }, [
      autoGainControl,
      echoCancellation,
      hasDesktopBridge,
      micQualityMode,
      noiseSuppression,
      voiceFilterStrength
    ]);
    const canRecordClip =
      typeof window !== 'undefined' &&
      typeof window.MediaRecorder !== 'undefined';
    const showDevRecordingControls = import.meta.env.DEV;

    const setClipUrl = useCallback((nextUrl: string | undefined) => {
      const previousUrl = recordedClipUrlRef.current;

      if (previousUrl && previousUrl !== nextUrl) {
        URL.revokeObjectURL(previousUrl);
      }

      recordedClipUrlRef.current = nextUrl;
      setRecordedClipUrl(nextUrl);
    }, []);

    const resolveMicAudioConstraints =
      useCallback((): MediaTrackConstraints => {
        return {
          ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
          autoGainControl: resolvedMicProcessingConfig.browserAutoGainControl,
          echoCancellation: resolvedMicProcessingConfig.browserEchoCancellation,
          noiseSuppression: resolvedMicProcessingConfig.browserNoiseSuppression
        };
      }, [microphoneId, resolvedMicProcessingConfig]);

    const stopRecordingClip = useCallback(async () => {
      const clearRecordingStopTracking = (resolvePendingStop: boolean) => {
        if (resolvePendingStop) {
          recordingStopResolveRef.current?.();
        }

        recordingStopResolveRef.current = undefined;
        recordingStopPromiseRef.current = undefined;
      };

      if (recordingTimeoutRef.current !== undefined) {
        clearTimeout(recordingTimeoutRef.current);
        recordingTimeoutRef.current = undefined;
      }

      const recorder = mediaRecorderRef.current;

      if (!recorder) {
        recordingChunksRef.current = [];
        setIsRecordingClip(false);
        clearRecordingStopTracking(true);
        return;
      }

      if (recorder.state === 'inactive') {
        mediaRecorderRef.current = undefined;
        recordingChunksRef.current = [];
        setIsRecordingClip(false);
        clearRecordingStopTracking(true);
        return;
      }

      if (!recordingStopPromiseRef.current) {
        recordingStopPromiseRef.current = new Promise<void>((resolve) => {
          recordingStopResolveRef.current = resolve;
        });
      }

      recorder.stop();
      await recordingStopPromiseRef.current;
    }, []);

    const setMutedStateForTest = useCallback(
      async ({
        nextMicMuted,
        nextSoundMuted
      }: {
        nextMicMuted: boolean;
        nextSoundMuted: boolean;
      }) => {
        if (
          micMutedRef.current === nextMicMuted &&
          soundMutedRef.current === nextSoundMuted
        ) {
          return;
        }

        const previousMicMuted = micMutedRef.current;
        const previousSoundMuted = soundMutedRef.current;
        micMutedRef.current = nextMicMuted;
        soundMutedRef.current = nextSoundMuted;
        updateOwnVoiceState({
          micMuted: nextMicMuted,
          soundMuted: nextSoundMuted
        });

        if (currentVoiceChannelId === undefined) {
          return;
        }

        try {
          await getTRPCClient().voice.updateState.mutate({
            micMuted: nextMicMuted,
            soundMuted: nextSoundMuted
          });
        } catch {
          micMutedRef.current = previousMicMuted;
          soundMutedRef.current = previousSoundMuted;
          updateOwnVoiceState({
            micMuted: previousMicMuted,
            soundMuted: previousSoundMuted
          });
        }
      },
      [currentVoiceChannelId]
    );

    const maybeMuteForTest = useCallback(async () => {
      if (currentVoiceChannelId === undefined) {
        return;
      }

      if (
        typeof micMutedBeforeTestRef.current === 'boolean' ||
        typeof soundMutedBeforeTestRef.current === 'boolean'
      ) {
        return;
      }

      micMutedBeforeTestRef.current = micMutedRef.current;
      soundMutedBeforeTestRef.current = soundMutedRef.current;

      if (!micMutedRef.current || !soundMutedRef.current) {
        await setMutedStateForTest({
          nextMicMuted: true,
          nextSoundMuted: true
        });
      }
    }, [currentVoiceChannelId, setMutedStateForTest]);

    const maybeRestoreMuteAfterTest = useCallback(async () => {
      const previousMicMuted = micMutedBeforeTestRef.current;
      const previousSoundMuted = soundMutedBeforeTestRef.current;

      if (
        typeof previousMicMuted !== 'boolean' ||
        typeof previousSoundMuted !== 'boolean'
      ) {
        return;
      }

      micMutedBeforeTestRef.current = undefined;
      soundMutedBeforeTestRef.current = undefined;
      await setMutedStateForTest({
        nextMicMuted: previousMicMuted,
        nextSoundMuted: previousSoundMuted
      });
    }, [setMutedStateForTest]);

    const stopTest = useCallback(async () => {
      runVersionRef.current += 1;
      await stopRecordingClip();

      if (animationFrameRef.current !== undefined) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = undefined;
      }

      const rawStream = rawStreamRef.current;
      rawStreamRef.current = undefined;
      rawStream?.getTracks().forEach((track) => {
        track.stop();
      });
      outputStreamRef.current = undefined;

      analyserRef.current = undefined;
      monitorGainNodeRef.current = undefined;

      const micAudioPipeline = micAudioPipelineRef.current;
      micAudioPipelineRef.current = undefined;

      if (micAudioPipeline) {
        await micAudioPipeline.destroy().catch(() => {
          // ignore cleanup failures
        });
      }

      const audioContext = audioContextRef.current;
      audioContextRef.current = undefined;

      if (audioContext) {
        await audioContext.close().catch(() => {
          // ignore cleanup failures
        });
      }

      setIsTestingMic(false);
      setTestUsesSidecar(false);
      setTestUsesInCallStream(false);
      if (levelBarRef.current) {
        levelBarRef.current.style.width = '0%';
      }
      await maybeRestoreMuteAfterTest();
    }, [maybeRestoreMuteAfterTest, stopRecordingClip]);

    const startTest = useCallback(async () => {
      const runVersion = runVersionRef.current + 1;
      await stopTest();
      runVersionRef.current = runVersion;
      setMicTestError(undefined);
      await maybeMuteForTest();

      const AudioContextClass =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;

      if (!AudioContextClass) {
        setMicTestError('Microphone testing is not supported in this browser.');
        return;
      }

      try {
        const inVoiceChannel = currentVoiceChannelId !== undefined;
        let rawStream: MediaStream | undefined;
        let outputStream = localAudioStream;
        let sidecarPipeline: TMicAudioProcessingPipeline | undefined;
        let usesInCallStream = false;

        if (inVoiceChannel && outputStream) {
          usesInCallStream = true;
        } else {
          if (
            resolvedMicProcessingConfig.sidecarVoiceProcessingEnabled &&
            !inVoiceChannel
          ) {
            // Sidecar mode — fail hard so the test reflects the real processing path.
            const desktopBridge = getDesktopBridge();
            if (!desktopBridge) {
              throw new Error(
                'Desktop bridge unavailable for sidecar microphone test.'
              );
            }
            const sidecarDeviceId = await resolveSidecarDeviceId(
              microphoneId,
              desktopBridge
            );
            sidecarPipeline = await createNativeSidecarMicCapturePipeline({
              suppressionLevel:
                resolvedMicProcessingConfig.sidecarSuppressionLevel,
              noiseSuppression:
                resolvedMicProcessingConfig.sidecarNoiseSuppression,
              autoGainControl:
                resolvedMicProcessingConfig.sidecarAutoGainControl,
              echoCancellation:
                resolvedMicProcessingConfig.sidecarEchoCancellation,
              dfnMix: resolvedMicProcessingConfig.sidecarDfnMix,
              dfnAttenuationLimitDb:
                resolvedMicProcessingConfig.sidecarDfnAttenuationLimitDb,
              dfnExperimentalAggressiveMode:
                resolvedMicProcessingConfig.sidecarExperimentalAggressiveMode,
              dfnNoiseGateFloorDbfs:
                resolvedMicProcessingConfig.sidecarNoiseGateFloorDbfs,
              sidecarDeviceId,
              desktopBridge
            });
            if (!sidecarPipeline) {
              throw new Error(
                'Failed to start native sidecar microphone capture.'
              );
            }
            outputStream = sidecarPipeline.stream;
          } else {
            rawStream = await navigator.mediaDevices.getUserMedia({
              audio: resolveMicAudioConstraints()
            });
            const rawTrack = rawStream.getAudioTracks()[0];

            if (!rawTrack) {
              throw new Error('Unable to access microphone track for testing.');
            }

            outputStream = rawStream;
          }
        }

        if (!outputStream) {
          throw new Error(
            'Unable to access an audio stream for microphone testing.'
          );
        }

        const audioContext = new AudioContextClass();
        const source = audioContext.createMediaStreamSource(outputStream);
        const analyser = audioContext.createAnalyser();
        const monitorGainNode = audioContext.createGain();

        analyser.fftSize = ANALYSER_FFT_SIZE;
        analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
        monitorGainNode.gain.value = monitorEnabled ? 1 : 0;

        source.connect(analyser);
        source.connect(monitorGainNode);
        monitorGainNode.connect(audioContext.destination);

        if (audioContext.state !== 'running') {
          await audioContext.resume();
        }

        if (runVersionRef.current !== runVersion) {
          rawStream?.getTracks().forEach((track) => {
            track.stop();
          });
          await sidecarPipeline?.destroy().catch(() => {
            // ignore stale cleanup failures
          });
          await audioContext.close().catch(() => {
            // ignore stale cleanup failures
          });
          return;
        }

        const timeDomainData = new Float32Array(analyser.fftSize);
        let displayLevel = 0;
        const ATTACK_COEFF = 0.3;
        const RELEASE_COEFF = 0.08;
        const updateInputLevel = () => {
          analyser.getFloatTimeDomainData(timeDomainData);

          let sumSquares = 0;
          for (let index = 0; index < timeDomainData.length; index += 1) {
            const sample = timeDomainData[index] ?? 0;
            sumSquares += sample * sample;
          }

          const rms = Math.sqrt(sumSquares / timeDomainData.length);
          const targetLevel = Math.min(
            LEVEL_CEILING,
            Math.max(LEVEL_FLOOR, (rms / RMS_NORMALIZATION) * LEVEL_CEILING)
          );
          const coeff =
            targetLevel > displayLevel ? ATTACK_COEFF : RELEASE_COEFF;
          displayLevel += (targetLevel - displayLevel) * coeff;
          if (levelBarRef.current) {
            levelBarRef.current.style.width = `${displayLevel}%`;
          }
          animationFrameRef.current = requestAnimationFrame(updateInputLevel);
        };

        rawStreamRef.current = rawStream;
        outputStreamRef.current = outputStream;
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        monitorGainNodeRef.current = monitorGainNode;
        micAudioPipelineRef.current = sidecarPipeline;

        setIsTestingMic(true);
        setTestUsesSidecar(Boolean(sidecarPipeline));
        setTestUsesInCallStream(usesInCallStream);
        setMicTestError(undefined);
        updateInputLevel();
      } catch (error) {
        setMicTestError(
          error instanceof Error
            ? error.message
            : 'Unable to access microphone for testing.'
        );
        await stopTest();
      }
    }, [
      maybeMuteForTest,
      microphoneId,
      monitorEnabled,
      localAudioStream,
      currentVoiceChannelId,
      resolvedMicProcessingConfig,
      resolveMicAudioConstraints,
      stopTest
    ]);

    const startRecordingClip = useCallback(async () => {
      if (isRecordingClip) {
        await stopRecordingClip();
        return;
      }

      setRecordingError(undefined);

      if (!canRecordClip) {
        setRecordingError(
          'Short clip recording is not supported in this browser.'
        );
        return;
      }

      try {
        let recordingStream = outputStreamRef.current;

        if (!recordingStream) {
          await startTest();
          recordingStream = outputStreamRef.current;
        }

        if (!recordingStream) {
          setRecordingError('Start microphone test first to record a clip.');
          return;
        }

        const MediaRecorderClass = window.MediaRecorder;
        const mimeType = PREFERRED_RECORDING_MIME_TYPES.find((candidate) => {
          if (typeof MediaRecorderClass.isTypeSupported === 'function') {
            return MediaRecorderClass.isTypeSupported(candidate);
          }

          return true;
        });
        const recorder = mimeType
          ? new MediaRecorderClass(recordingStream, {
              mimeType,
              audioBitsPerSecond: 128_000
            })
          : new MediaRecorderClass(recordingStream);

        mediaRecorderRef.current = recorder;
        recordingChunksRef.current = [];

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            recordingChunksRef.current.push(event.data);
          }
        };

        recorder.onerror = (event) => {
          setRecordingError(
            event.error?.message || 'Failed to record microphone clip.'
          );

          if (recordingTimeoutRef.current !== undefined) {
            clearTimeout(recordingTimeoutRef.current);
            recordingTimeoutRef.current = undefined;
          }

          if (recorder.state !== 'inactive') {
            try {
              recorder.stop();
              return;
            } catch {
              // fall through to local cleanup
            }
          }

          mediaRecorderRef.current = undefined;
          recordingChunksRef.current = [];
          setIsRecordingClip(false);
          recordingStopResolveRef.current?.();
          recordingStopResolveRef.current = undefined;
          recordingStopPromiseRef.current = undefined;
        };

        recorder.onstop = () => {
          if (recordingTimeoutRef.current !== undefined) {
            clearTimeout(recordingTimeoutRef.current);
            recordingTimeoutRef.current = undefined;
          }

          const outputMimeType = recorder.mimeType || mimeType || 'audio/webm';
          const blob = new Blob(recordingChunksRef.current, {
            type: outputMimeType
          });

          if (blob.size > 0) {
            const clipUrl = URL.createObjectURL(blob);
            setClipUrl(clipUrl);
          } else {
            setRecordingError('Recorded clip was empty. Please try again.');
          }

          mediaRecorderRef.current = undefined;
          recordingChunksRef.current = [];
          setIsRecordingClip(false);
          recordingStopResolveRef.current?.();
          recordingStopResolveRef.current = undefined;
          recordingStopPromiseRef.current = undefined;
        };

        setClipUrl(undefined);
        setMonitorEnabled(false);
        recorder.start();
        setIsRecordingClip(true);
      } catch (error) {
        setRecordingError(
          error instanceof Error
            ? error.message
            : 'Unable to record microphone clip.'
        );
        await stopRecordingClip();
      }
    }, [
      canRecordClip,
      isRecordingClip,
      setClipUrl,
      startTest,
      stopRecordingClip
    ]);

    const clearRecordedClip = useCallback(() => {
      setClipUrl(undefined);
      setRecordingError(undefined);
    }, [setClipUrl]);

    useEffect(() => {
      const monitorGainNode = monitorGainNodeRef.current;
      if (!monitorGainNode) {
        return;
      }

      monitorGainNode.gain.value = monitorEnabled ? 1 : 0;
    }, [monitorEnabled]);

    useEffect(() => {
      micMutedRef.current = ownVoiceState.micMuted;
    }, [ownVoiceState.micMuted]);

    useEffect(() => {
      soundMutedRef.current = ownVoiceState.soundMuted;
    }, [ownVoiceState.soundMuted]);

    useEffect(() => {
      return () => {
        void stopTest();
      };
    }, [stopTest]);

    // Restart the running test automatically when processing config changes.
    const isTestingMicRef = useRef(false);
    useEffect(() => {
      isTestingMicRef.current = isTestingMic;
    }, [isTestingMic]);

    useEffect(() => {
      if (!isTestingMicRef.current) {
        return;
      }

      void startTest();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resolvedMicProcessingConfig]);

    useEffect(() => {
      return () => {
        const currentClipUrl = recordedClipUrlRef.current;
        if (currentClipUrl) {
          URL.revokeObjectURL(currentClipUrl);
          recordedClipUrlRef.current = undefined;
        }
      };
    }, []);

    return (
      <div className="space-y-4 rounded-xl border-l-2 border-l-primary/40 bg-secondary p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Mic className="h-4 w-4 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Microphone test</p>
              <p className="text-xs text-muted-foreground">
                Preview your microphone input level.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Label className="cursor-default text-xs text-muted-foreground">
                Hear yourself
              </Label>
              <Switch
                checked={monitorEnabled}
                onCheckedChange={setMonitorEnabled}
                disabled={!isTestingMic}
              />
            </div>
            <Button
              type="button"
              variant={isTestingMic ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => {
                if (isTestingMic) {
                  void stopTest();
                  return;
                }

                void startTest();
              }}
            >
              {isTestingMic ? 'Stop test' : 'Start test'}
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Input level</p>
            {isTestingMic && (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {testUsesInCallStream
                  ? 'In-call stream'
                  : testUsesSidecar
                    ? 'Enhanced processing'
                    : 'Browser capture'}
              </span>
            )}
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-background/60">
            <div
              ref={levelBarRef}
              className="h-full rounded-full bg-white"
              style={{ width: '0%' }}
            />
          </div>
        </div>

        {showDevRecordingControls && (
          <div className="space-y-2 border-t border-border/40 pt-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="text-xs font-medium">Short recording</p>
                <p className="text-xs text-muted-foreground">
                  Record a clip and play it back.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void startRecordingClip();
                }}
                disabled={!canRecordClip}
              >
                {isRecordingClip ? (
                  <>
                    <Circle className="h-3 w-3 animate-pulse fill-red-500 text-red-500" />
                    Stop
                  </>
                ) : (
                  <>
                    <Circle className="h-3 w-3 fill-current" />
                    Record
                  </>
                )}
              </Button>
            </div>

            {!canRecordClip && (
              <p className="text-xs text-muted-foreground">
                Clip recording is not supported in this browser.
              </p>
            )}

            {recordedClipUrl && (
              <div className="mt-4 flex items-center gap-2">
                <audio controls src={recordedClipUrl} className="h-8 flex-1" />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={clearRecordedClip}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}

            {recordingError && (
              <p className="text-xs text-destructive">{recordingError}</p>
            )}
          </div>
        )}

        {micTestError && (
          <p className="text-xs text-destructive">{micTestError}</p>
        )}
      </div>
    );
  }
);

MicrophoneTestPanel.displayName = 'MicrophoneTestPanel';

export { MicrophoneTestPanel };
