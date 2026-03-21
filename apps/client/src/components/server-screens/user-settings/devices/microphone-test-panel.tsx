import { Circle, Mic, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
	createMicAudioProcessingPipeline,
	createNativeSidecarMicCapturePipeline,
	resolveSidecarDeviceId,
	type TMicAudioProcessingPipeline,
} from '@/components/voice-provider/mic-audio-processing';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { updateOwnVoiceState } from '@/features/server/voice/actions';
import { useOwnVoiceState, useVoice } from '@/features/server/voice/hooks';
import { getTRPCClient } from '@/lib/trpc';
import { getDesktopBridge } from '@/runtime/desktop-bridge';
import { getStrengthDefaults, MicQualityMode, type VoiceFilterStrength } from '@/types';

const ANALYSER_FFT_SIZE = 512;
const ANALYSER_SMOOTHING = 0.8;
const LEVEL_FLOOR = 0;
const LEVEL_CEILING = 100;
const RMS_NORMALIZATION = 0.3;
const PREFERRED_RECORDING_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
const WASM_DIAGNOSTIC_SAMPLE_RATE = 48_000;

type TMicrophoneTestPanelProps = {
	microphoneId: string | undefined;
	micQualityMode: MicQualityMode;
	voiceFilterStrength: VoiceFilterStrength;
	echoCancellation: boolean;
	noiseSuppression: boolean;
	wasmNoiseSuppressionEnabled: boolean;
	autoGainControl: boolean;
	hasDesktopBridge: boolean;
};

type TResolvedMicTestProcessingConfig = {
	sidecarVoiceProcessingEnabled: boolean;
	wasmNoiseSuppressionEnabled: boolean;
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

type TWasmDenoiseDiagSnapshot = NonNullable<Window['wasmDenoiseDiag']>;
type TMicTestPreviewState = 'browser-capture' | 'browser-wasm' | 'in-call-stream' | 'sidecar-native';

const getMicTestPreviewLabel = (previewState: TMicTestPreviewState | undefined): string => {
	switch (previewState) {
		case 'browser-wasm':
			return 'Browser WASM';
		case 'in-call-stream':
			return 'In-call stream';
		case 'sidecar-native':
			return 'Native sidecar';
		case 'browser-capture':
		default:
			return 'Browser capture';
	}
};

const isBrowserWasmPreviewState = (previewState: TMicTestPreviewState | undefined): previewState is 'browser-wasm' => {
	return previewState === 'browser-wasm';
};

const formatDiagnosticDurationMs = (value: number | null): string => {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return '—';
	}

	return `${value.toFixed(1)} ms`;
};

const formatQueueDepthMs = (frames: number): string => {
	const durationMs = (frames / WASM_DIAGNOSTIC_SAMPLE_RATE) * 1_000;
	return `${durationMs.toFixed(1)} ms`;
};

const resolveMicTestProcessingConfig = ({
	micQualityMode,
	hasDesktopBridge,
	voiceFilterStrength,
	echoCancellation,
	noiseSuppression,
	wasmNoiseSuppressionEnabled,
	autoGainControl,
}: {
	micQualityMode: MicQualityMode;
	hasDesktopBridge: boolean;
	voiceFilterStrength: VoiceFilterStrength;
	echoCancellation: boolean;
	noiseSuppression: boolean;
	wasmNoiseSuppressionEnabled: boolean;
	autoGainControl: boolean;
}): TResolvedMicTestProcessingConfig => {
	const defaults = getStrengthDefaults(voiceFilterStrength);
	const browserWasmNoiseSuppressionEnabled = wasmNoiseSuppressionEnabled && noiseSuppression;

	if (micQualityMode === MicQualityMode.EXPERIMENTAL) {
		const sidecarVoiceProcessingEnabled = hasDesktopBridge;

		return {
			sidecarVoiceProcessingEnabled,
			wasmNoiseSuppressionEnabled: !sidecarVoiceProcessingEnabled && browserWasmNoiseSuppressionEnabled,
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
			sidecarNoiseGateFloorDbfs: defaults.dfnNoiseGateFloorDbfs,
		};
	}

	// Standard (AUTO) and legacy MANUAL — browser-only, no sidecar.
	// Echo cancellation is forced off for the test: the monitor plays your mic
	// back through speakers, which the browser AEC would treat as echo and cancel,
	// making the playback sound broken.
	return {
		sidecarVoiceProcessingEnabled: false,
		wasmNoiseSuppressionEnabled: browserWasmNoiseSuppressionEnabled,
		browserAutoGainControl: autoGainControl,
		browserNoiseSuppression: browserWasmNoiseSuppressionEnabled ? false : noiseSuppression,
		browserEchoCancellation: false,
		sidecarNoiseSuppression: noiseSuppression,
		sidecarAutoGainControl: autoGainControl,
		sidecarEchoCancellation: false,
		sidecarSuppressionLevel: voiceFilterStrength,
		sidecarDfnMix: defaults.dfnMix,
		sidecarDfnAttenuationLimitDb: defaults.dfnAttenuationLimitDb,
		sidecarExperimentalAggressiveMode: defaults.dfnExperimentalAggressiveMode,
		sidecarNoiseGateFloorDbfs: defaults.dfnNoiseGateFloorDbfs,
	};
};

const MicrophoneTestPanel = memo(
	({
		microphoneId,
		micQualityMode,
		voiceFilterStrength,
		echoCancellation,
		noiseSuppression,
		wasmNoiseSuppressionEnabled,
		autoGainControl,
		hasDesktopBridge,
	}: TMicrophoneTestPanelProps) => {
		const currentVoiceChannelId = useCurrentVoiceChannelId();
		const { localAudioStream } = useVoice();
		const ownVoiceState = useOwnVoiceState();
		const [isTestingMic, setIsTestingMic] = useState(false);
		const [monitorEnabled, setMonitorEnabled] = useState(false);
		const levelBarRef = useRef<HTMLDivElement>(null);
		const [micTestError, setMicTestError] = useState<string | undefined>(undefined);
		const [isRecordingClip, setIsRecordingClip] = useState(false);
		const [testPreviewState, setTestPreviewState] = useState<TMicTestPreviewState | undefined>(undefined);
		const [wasmDiagnostics, setWasmDiagnostics] = useState<TWasmDenoiseDiagSnapshot | undefined>(undefined);
		const [recordingError, setRecordingError] = useState<string | undefined>(undefined);
		const [recordedClipUrl, setRecordedClipUrl] = useState<string | undefined>(undefined);
		const rawStreamRef = useRef<MediaStream | undefined>(undefined);
		const outputStreamRef = useRef<MediaStream | undefined>(undefined);
		const audioContextRef = useRef<AudioContext | undefined>(undefined);
		const analyserRef = useRef<AnalyserNode | undefined>(undefined);
		const monitorGainNodeRef = useRef<GainNode | undefined>(undefined);
		const animationFrameRef = useRef<number | undefined>(undefined);
		const runVersionRef = useRef(0);
		const micAudioPipelineRef = useRef<TMicAudioProcessingPipeline | undefined>(undefined);
		const mediaRecorderRef = useRef<MediaRecorder | undefined>(undefined);
		const recordingTimeoutRef = useRef<number | undefined>(undefined);
		const recordingChunksRef = useRef<BlobPart[]>([]);
		const recordingStopPromiseRef = useRef<Promise<void> | undefined>(undefined);
		const recordingStopResolveRef = useRef<(() => void) | undefined>(undefined);
		const recordedClipUrlRef = useRef<string | undefined>(undefined);
		const micMutedRef = useRef(ownVoiceState.micMuted);
		const soundMutedRef = useRef(ownVoiceState.soundMuted);
		const micMutedBeforeTestRef = useRef<boolean | undefined>(undefined);
		const soundMutedBeforeTestRef = useRef<boolean | undefined>(undefined);
		const monitorEnabledRef = useRef(monitorEnabled);
		const resolvedMicProcessingConfig = useMemo(() => {
			return resolveMicTestProcessingConfig({
				micQualityMode,
				hasDesktopBridge,
				voiceFilterStrength,
				echoCancellation,
				noiseSuppression,
				wasmNoiseSuppressionEnabled,
				autoGainControl,
			});
		}, [
			autoGainControl,
			echoCancellation,
			hasDesktopBridge,
			micQualityMode,
			noiseSuppression,
			voiceFilterStrength,
			wasmNoiseSuppressionEnabled,
		]);
		const canRecordClip = typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';
		const showDevMicTestControls = import.meta.env.DEV;
		const showWasmDiagnostics = showDevMicTestControls && isTestingMic && isBrowserWasmPreviewState(testPreviewState);
		const wasmDiagnosticItems = wasmDiagnostics
			? [
					{
						label: 'Blocks',
						value: wasmDiagnostics.processedBlocks.toLocaleString(),
					},
					{
						label: 'Average',
						value: formatDiagnosticDurationMs(wasmDiagnostics.averageProcessTimeMs),
					},
					{
						label: 'Peak',
						value: formatDiagnosticDurationMs(wasmDiagnostics.maxProcessTimeMs),
					},
					{
						label: 'Input queue',
						value: formatQueueDepthMs(wasmDiagnostics.inputQueueFrames),
					},
					{
						label: 'Output queue',
						value: formatQueueDepthMs(wasmDiagnostics.outputQueueFrames),
					},
					{
						label: 'Input drops',
						value: wasmDiagnostics.inputDrops.toLocaleString(),
						tone: wasmDiagnostics.inputDrops > 0 ? 'warning' : 'default',
					},
					{
						label: 'Output drops',
						value: wasmDiagnostics.outputDrops.toLocaleString(),
						tone: wasmDiagnostics.outputDrops > 0 ? 'warning' : 'default',
					},
					{
						label: 'Underruns',
						value: wasmDiagnostics.outputUnderruns.toLocaleString(),
						tone: wasmDiagnostics.outputUnderruns > 0 ? 'warning' : 'default',
					},
				]
			: undefined;

		const setClipUrl = useCallback((nextUrl: string | undefined) => {
			const previousUrl = recordedClipUrlRef.current;

			if (previousUrl && previousUrl !== nextUrl) {
				URL.revokeObjectURL(previousUrl);
			}

			recordedClipUrlRef.current = nextUrl;
			setRecordedClipUrl(nextUrl);
		}, []);

		const resolveMicAudioConstraints = useCallback((): MediaTrackConstraints => {
			return {
				...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
				autoGainControl: resolvedMicProcessingConfig.browserAutoGainControl,
				echoCancellation: resolvedMicProcessingConfig.browserEchoCancellation,
				noiseSuppression: resolvedMicProcessingConfig.browserNoiseSuppression,
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
			async ({ nextMicMuted, nextSoundMuted }: { nextMicMuted: boolean; nextSoundMuted: boolean }) => {
				if (micMutedRef.current === nextMicMuted && soundMutedRef.current === nextSoundMuted) {
					return;
				}

				const previousMicMuted = micMutedRef.current;
				const previousSoundMuted = soundMutedRef.current;
				micMutedRef.current = nextMicMuted;
				soundMutedRef.current = nextSoundMuted;
				updateOwnVoiceState({
					micMuted: nextMicMuted,
					soundMuted: nextSoundMuted,
				});

				if (currentVoiceChannelId === undefined) {
					return;
				}

				try {
					await getTRPCClient().voice.updateState.mutate({
						micMuted: nextMicMuted,
						soundMuted: nextSoundMuted,
					});
				} catch {
					micMutedRef.current = previousMicMuted;
					soundMutedRef.current = previousSoundMuted;
					updateOwnVoiceState({
						micMuted: previousMicMuted,
						soundMuted: previousSoundMuted,
					});
				}
			},
			[currentVoiceChannelId],
		);

		const maybeMuteForTest = useCallback(async () => {
			if (currentVoiceChannelId === undefined) {
				return;
			}

			if (typeof micMutedBeforeTestRef.current === 'boolean' || typeof soundMutedBeforeTestRef.current === 'boolean') {
				return;
			}

			micMutedBeforeTestRef.current = micMutedRef.current;
			soundMutedBeforeTestRef.current = soundMutedRef.current;

			if (!micMutedRef.current || !soundMutedRef.current) {
				await setMutedStateForTest({
					nextMicMuted: true,
					nextSoundMuted: true,
				});
			}
		}, [currentVoiceChannelId, setMutedStateForTest]);

		const maybeRestoreMuteAfterTest = useCallback(async () => {
			const previousMicMuted = micMutedBeforeTestRef.current;
			const previousSoundMuted = soundMutedBeforeTestRef.current;

			if (typeof previousMicMuted !== 'boolean' || typeof previousSoundMuted !== 'boolean') {
				return;
			}

			micMutedBeforeTestRef.current = undefined;
			soundMutedBeforeTestRef.current = undefined;
			await setMutedStateForTest({
				nextMicMuted: previousMicMuted,
				nextSoundMuted: previousSoundMuted,
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
			setTestPreviewState(undefined);
			setWasmDiagnostics(undefined);
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
				(window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

			if (!AudioContextClass) {
				setMicTestError('Microphone testing is not supported in this browser.');
				return;
			}

			try {
				const inVoiceChannel = currentVoiceChannelId !== undefined;
				let rawStream: MediaStream | undefined;
				let outputStream = localAudioStream;
				let micAudioPipeline: TMicAudioProcessingPipeline | undefined;
				let previewState: TMicTestPreviewState = 'browser-capture';

				if (inVoiceChannel && outputStream) {
					previewState = 'in-call-stream';
				} else {
					if (resolvedMicProcessingConfig.sidecarVoiceProcessingEnabled && !inVoiceChannel) {
						// Sidecar mode — fail hard so the test reflects the real processing path.
						const desktopBridge = getDesktopBridge();
						if (!desktopBridge) {
							throw new Error('Desktop bridge unavailable for sidecar microphone test.');
						}
						const sidecarDeviceId = await resolveSidecarDeviceId(microphoneId, desktopBridge);
						micAudioPipeline = await createNativeSidecarMicCapturePipeline({
							suppressionLevel: resolvedMicProcessingConfig.sidecarSuppressionLevel,
							noiseSuppression: resolvedMicProcessingConfig.sidecarNoiseSuppression,
							autoGainControl: resolvedMicProcessingConfig.sidecarAutoGainControl,
							echoCancellation: resolvedMicProcessingConfig.sidecarEchoCancellation,
							dfnMix: resolvedMicProcessingConfig.sidecarDfnMix,
							dfnAttenuationLimitDb: resolvedMicProcessingConfig.sidecarDfnAttenuationLimitDb,
							dfnExperimentalAggressiveMode: resolvedMicProcessingConfig.sidecarExperimentalAggressiveMode,
							dfnNoiseGateFloorDbfs: resolvedMicProcessingConfig.sidecarNoiseGateFloorDbfs,
							sidecarDeviceId,
							desktopBridge,
						});
						if (!micAudioPipeline) {
							throw new Error('Failed to start native sidecar microphone capture.');
						}
						outputStream = micAudioPipeline.stream;
						previewState = 'sidecar-native';
					} else {
						rawStream = await navigator.mediaDevices.getUserMedia({
							audio: resolveMicAudioConstraints(),
						});
						const rawTrack = rawStream.getAudioTracks()[0];

						if (!rawTrack) {
							throw new Error('Unable to access microphone track for testing.');
						}

						micAudioPipeline = await createMicAudioProcessingPipeline({
							inputTrack: rawTrack,
							enabled: false,
							wasmNoiseSuppressionEnabled: resolvedMicProcessingConfig.wasmNoiseSuppressionEnabled,
							suppressionLevel: resolvedMicProcessingConfig.sidecarSuppressionLevel,
							noiseSuppression: resolvedMicProcessingConfig.sidecarNoiseSuppression,
							autoGainControl: resolvedMicProcessingConfig.sidecarAutoGainControl,
							echoCancellation: resolvedMicProcessingConfig.sidecarEchoCancellation,
							dfnMix: resolvedMicProcessingConfig.sidecarDfnMix,
							dfnAttenuationLimitDb: resolvedMicProcessingConfig.sidecarDfnAttenuationLimitDb,
							dfnExperimentalAggressiveMode: resolvedMicProcessingConfig.sidecarExperimentalAggressiveMode,
							dfnNoiseGateFloorDbfs: resolvedMicProcessingConfig.sidecarNoiseGateFloorDbfs,
							onWasmError: (error) => {
								setMicTestError(error.message);
								void stopTest();
							},
						});

						if (micAudioPipeline?.backend === 'browser-wasm') {
							outputStream = micAudioPipeline.stream;
							previewState = 'browser-wasm';
						} else if (micAudioPipeline?.backend === 'sidecar-native') {
							outputStream = micAudioPipeline.stream;
							previewState = 'sidecar-native';
						} else {
							outputStream = rawStream;
							previewState = 'browser-capture';
						}
					}
				}

				if (!outputStream) {
					throw new Error('Unable to access an audio stream for microphone testing.');
				}

				const audioContext = new AudioContextClass();
				const source = audioContext.createMediaStreamSource(outputStream);
				const analyser = audioContext.createAnalyser();
				const monitorGainNode = audioContext.createGain();

				analyser.fftSize = ANALYSER_FFT_SIZE;
				analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
				monitorGainNode.gain.value = monitorEnabledRef.current ? 1 : 0;

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
					await micAudioPipeline?.destroy().catch(() => {
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
					const targetLevel = Math.min(LEVEL_CEILING, Math.max(LEVEL_FLOOR, (rms / RMS_NORMALIZATION) * LEVEL_CEILING));
					const coeff = targetLevel > displayLevel ? ATTACK_COEFF : RELEASE_COEFF;
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
				micAudioPipelineRef.current = micAudioPipeline;

				setIsTestingMic(true);
				setTestPreviewState(previewState);
				setMicTestError(undefined);
				updateInputLevel();
			} catch (error) {
				setMicTestError(error instanceof Error ? error.message : 'Unable to access microphone for testing.');
				await stopTest();
			}
		}, [
			maybeMuteForTest,
			microphoneId,
			localAudioStream,
			currentVoiceChannelId,
			resolvedMicProcessingConfig,
			resolveMicAudioConstraints,
			stopTest,
		]);

		const startRecordingClip = useCallback(async () => {
			if (isRecordingClip) {
				await stopRecordingClip();
				return;
			}

			setRecordingError(undefined);

			if (!canRecordClip) {
				setRecordingError('Short clip recording is not supported in this browser.');
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
							audioBitsPerSecond: 128_000,
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
					setRecordingError(event.error?.message || 'Failed to record microphone clip.');

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
						type: outputMimeType,
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
				setRecordingError(error instanceof Error ? error.message : 'Unable to record microphone clip.');
				await stopRecordingClip();
			}
		}, [canRecordClip, isRecordingClip, setClipUrl, startTest, stopRecordingClip]);

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
			monitorEnabledRef.current = monitorEnabled;
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

		useEffect(() => {
			if (!showWasmDiagnostics) {
				setWasmDiagnostics(undefined);
				return;
			}

			const syncDiagnostics = () => {
				setWasmDiagnostics(window.wasmDenoiseDiag ?? undefined);
			};

			syncDiagnostics();
			const intervalId = window.setInterval(syncDiagnostics, 250);

			return () => {
				window.clearInterval(intervalId);
			};
		}, [showWasmDiagnostics]);

		// Restart the running test automatically when processing config changes.
		const isTestingMicRef = useRef(false);
		useEffect(() => {
			isTestingMicRef.current = isTestingMic;
		}, [isTestingMic]);

		// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally only restart when processing config changes, not all startTest deps
		useEffect(() => {
			if (!isTestingMicRef.current) {
				return;
			}

			void startTest();
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
			<div className="space-y-4 border-t border-border/50 pt-4">
				<div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
					<div className="flex items-start gap-3">
						<div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
							<Mic className="h-4 w-4 text-primary" />
						</div>
						<div className="space-y-1">
							<div className="flex flex-wrap items-center gap-2">
								<p className="text-sm font-semibold">Microphone test</p>
								{isTestingMic && testPreviewState && (
									<Badge
										variant="outline"
										className="border-primary/30 bg-primary/5 text-[10px] uppercase tracking-[0.14em] text-primary"
									>
										{getMicTestPreviewLabel(testPreviewState)}
									</Badge>
								)}
							</div>
							<p className="text-xs text-muted-foreground">Check the live level and record a short playback sample.</p>
						</div>
					</div>

					<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-4">
						<div className="flex items-center gap-3">
							<Label className="cursor-default whitespace-nowrap text-xs text-muted-foreground">Hear yourself</Label>
							<Switch checked={monitorEnabled} onCheckedChange={setMonitorEnabled} disabled={!isTestingMic} />
						</div>
						<Button
							type="button"
							variant={isTestingMic ? 'secondary' : 'outline'}
							size="sm"
							className="min-w-[104px]"
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

				{isTestingMic && (
					<div className="space-y-2 border-t border-border/40 pt-3">
						<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
							<div className="space-y-1">
								<p className="text-xs font-medium">Input level</p>
								<p className="text-xs text-muted-foreground">
									Speak at a normal volume to check your level and cleanup path.
								</p>
							</div>
							<Badge variant="secondary" className="text-[10px] uppercase tracking-[0.14em]">
								{testPreviewState ? 'Live' : 'Idle'}
							</Badge>
						</div>
						<div className="h-2.5 w-full overflow-hidden rounded-full bg-background/80">
							<div
								ref={levelBarRef}
								className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-sky-400 to-cyan-300 transition-[width]"
								style={{ width: '0%' }}
							/>
						</div>
					</div>
				)}

				{showWasmDiagnostics && (
					<div className="space-y-3 rounded-xl border border-primary/20 bg-background/40 p-3">
						<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
							<div className="space-y-1">
								<p className="text-xs font-medium">Browser WASM diagnostics</p>
								<p className="text-xs text-muted-foreground">You are hearing the browser-side WASM denoised stream.</p>
							</div>
							{wasmDiagnostics && (
								<Badge variant="secondary" className="text-[10px] uppercase tracking-[0.14em]">
									{wasmDiagnostics.transportMode === 'shared-array-buffer' ? 'SharedArrayBuffer' : 'MessagePort'}
								</Badge>
							)}
						</div>

						{wasmDiagnosticItems ? (
							<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
								{wasmDiagnosticItems.map((item) => {
									return (
										<div key={item.label} className="rounded-lg border border-border/50 bg-background/75 p-2.5">
											<p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{item.label}</p>
											<p
												className={`mt-1 text-sm font-semibold ${
													item.tone === 'warning' ? 'text-amber-600 dark:text-amber-300' : 'text-foreground'
												}`}
											>
												{item.value}
											</p>
										</div>
									);
								})}
							</div>
						) : (
							<p className="text-xs text-muted-foreground">Waiting for browser WASM worker telemetry...</p>
						)}
					</div>
				)}

				{showDevMicTestControls && (
					<div className="space-y-3 border-t border-border/40 pt-3">
						<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<div className="space-y-1">
								<p className="text-xs font-medium">Short recording</p>
								<p className="text-xs text-muted-foreground">Record a short clip and play it back immediately.</p>
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
							<p className="text-xs text-muted-foreground">Clip recording is not supported in this browser.</p>
						)}

						{recordedClipUrl && (
							<div className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/80 p-2">
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
							<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
								<p className="text-xs text-destructive">{recordingError}</p>
							</div>
						)}
					</div>
				)}

				{micTestError && (
					<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
						<p className="text-xs text-destructive">{micTestError}</p>
					</div>
				)}
			</div>
		);
	},
);

MicrophoneTestPanel.displayName = 'MicrophoneTestPanel';

export { MicrophoneTestPanel };
