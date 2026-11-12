import { Circle, Mic, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { createMicAudioProcessingPipeline } from '@/components/voice-provider/microphone/mic-audio-processing';
import { setOwnMicTestActive } from '@/features/server/voice/actions';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { createMicTestResources, runMicTestSetup } from './mic-test-resources';
import { createMicTestRunOwner } from './mic-test-run-owner';

const ANALYSER_FFT_SIZE = 512;
const ANALYSER_SMOOTHING = 0.8;
const LEVEL_FLOOR = 0;
const LEVEL_CEILING = 100;
const RMS_NORMALIZATION = 0.3;
const PREFERRED_RECORDING_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
const WASM_DIAGNOSTIC_SAMPLE_RATE = 48_000;

type TMicrophoneTestPanelProps = {
	microphoneId: string | undefined;
	noiseSuppression: boolean;
	wasmNoiseSuppressionEnabled: boolean;
	autoGainControl: boolean;
};

type TResolvedMicTestProcessingConfig = {
	wasmNoiseSuppressionEnabled: boolean;
	browserAutoGainControl: boolean;
	browserNoiseSuppression: boolean;
	browserEchoCancellation: boolean;
};

type TWasmDenoiseDiagSnapshot = NonNullable<Window['wasmDenoiseDiag']>;
type TMicTestPreviewState = 'browser-capture' | 'browser-wasm';

const getMicTestPreviewLabel = (previewState: TMicTestPreviewState | undefined): string => {
	switch (previewState) {
		case 'browser-wasm':
			return 'Browser WASM';
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
	noiseSuppression,
	wasmNoiseSuppressionEnabled,
	autoGainControl,
}: {
	noiseSuppression: boolean;
	wasmNoiseSuppressionEnabled: boolean;
	autoGainControl: boolean;
}): TResolvedMicTestProcessingConfig => {
	const browserWasmNoiseSuppressionEnabled = wasmNoiseSuppressionEnabled && noiseSuppression;

	// Echo cancellation is forced off for the test: the monitor plays your mic
	// back through speakers, which the browser AEC would treat as echo and cancel,
	// making the playback sound broken.
	return {
		wasmNoiseSuppressionEnabled: browserWasmNoiseSuppressionEnabled,
		browserAutoGainControl: autoGainControl,
		browserNoiseSuppression: browserWasmNoiseSuppressionEnabled ? false : noiseSuppression,
		browserEchoCancellation: false,
	};
};

const MicrophoneTestPanel = memo(
	({ microphoneId, noiseSuppression, wasmNoiseSuppressionEnabled, autoGainControl }: TMicrophoneTestPanelProps) => {
		const [isTestingMic, setIsTestingMic] = useState(false);
		const [monitorEnabled, setMonitorEnabled] = useState(false);
		const levelBarRef = useRef<HTMLDivElement>(null);
		const [micTestError, setMicTestError] = useState<string | undefined>(undefined);
		const [isRecordingClip, setIsRecordingClip] = useState(false);
		const [testPreviewState, setTestPreviewState] = useState<TMicTestPreviewState | undefined>(undefined);
		const [wasmDiagnostics, setWasmDiagnostics] = useState<TWasmDenoiseDiagSnapshot | undefined>(undefined);
		const [recordingError, setRecordingError] = useState<string | undefined>(undefined);
		const [recordedClipUrl, setRecordedClipUrl] = useState<string | undefined>(undefined);
		const outputStreamRef = useRef<MediaStream | undefined>(undefined);
		const monitorGainNodeRef = useRef<GainNode | undefined>(undefined);
		const animationFrameRef = useRef<number | undefined>(undefined);
		const mediaRecorderRef = useRef<MediaRecorder | undefined>(undefined);
		const recordingTimeoutRef = useRef<number | undefined>(undefined);
		const recordingChunksRef = useRef<BlobPart[]>([]);
		const recordingStopPromiseRef = useRef<Promise<void> | undefined>(undefined);
		const recordingStopResolveRef = useRef<(() => void) | undefined>(undefined);
		const recordedClipUrlRef = useRef<string | undefined>(undefined);
		const monitorEnabledRef = useLatestRef(monitorEnabled);
		const resolvedMicProcessingConfig = useMemo(() => {
			return resolveMicTestProcessingConfig({
				noiseSuppression,
				wasmNoiseSuppressionEnabled,
				autoGainControl,
			});
		}, [autoGainControl, noiseSuppression, wasmNoiseSuppressionEnabled]);
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
				if (recordingStopPromiseRef.current) {
					await recordingStopPromiseRef.current;
					return;
				}
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

		const resourcesRef = useRef<ReturnType<typeof createMicTestResources> | undefined>(undefined);
		const teardown = useCallback(() => {
			const resources = resourcesRef.current;
			resourcesRef.current = undefined;
			const resourceDrain = resources?.detach();
			// Detach and stop everything before the first await; newer runs await the drain.
			const recording = stopRecordingClip();
			if (animationFrameRef.current !== undefined) cancelAnimationFrame(animationFrameRef.current);
			animationFrameRef.current = undefined;
			outputStreamRef.current = undefined;
			monitorGainNodeRef.current = undefined;
			setIsTestingMic(false);
			setTestPreviewState(undefined);
			setWasmDiagnostics(undefined);
			if (levelBarRef.current) levelBarRef.current.style.width = '0%';
			const drain = Promise.all([recording, resourceDrain]).then(() => {});
			return drain;
		}, [stopRecordingClip]);
		const teardownLatest = useLatestRef(teardown);
		const ownerRef = useRef<ReturnType<typeof createMicTestRunOwner> | undefined>(undefined);
		if (!ownerRef.current)
			ownerRef.current = createMicTestRunOwner({
				detach: () => teardownLatest.current(),
				setActive: setOwnMicTestActive,
			});
		const owner = ownerRef.current;
		const stopTest = useCallback(() => owner.stop(), [owner]);

		const startTest = useCallback(async () => {
			const run = owner.begin();
			try {
				await run.ready;
			} catch (error) {
				if (run.isCurrent()) {
					setMicTestError(error instanceof Error ? error.message : 'Unable to stop microphone test.');
					await run.fail();
				}
				return;
			}
			if (!run.isCurrent()) return;
			setMicTestError(undefined);

			const AudioContextClass = window.AudioContext || window.webkitAudioContext;

			if (!AudioContextClass) {
				setMicTestError('Microphone testing is not supported in this browser.');
				await run.fail();
				return;
			}

			run.activate();
			setIsTestingMic(true);
			const resources = createMicTestResources(run.isCurrent);
			resourcesRef.current = resources;
			await run.track(
				(async () => {
					try {
						await runMicTestSetup({
							resources,
							isCurrent: run.isCurrent,
							capture: () => navigator.mediaDevices.getUserMedia({ audio: resolveMicAudioConstraints() }),
							stopCapture: (stream) => {
								stream.getTracks().forEach((track) => track.stop());
							},
							pipeline: (raw) => {
								const rawTrack = raw.getAudioTracks()[0];
								if (!rawTrack) throw new Error('Unable to access microphone track for testing.');
								return createMicAudioProcessingPipeline({
									inputTrack: rawTrack,
									wasmNoiseSuppressionEnabled: resolvedMicProcessingConfig.wasmNoiseSuppressionEnabled,
									onWasmError: (error) => {
										if (run.isCurrent()) {
											setMicTestError(error.message);
											void run.fail();
										}
									},
								});
							},
							destroyPipeline: (pipeline) => pipeline?.destroy(),
							monitor: (raw, pipeline) => {
								const outputStream = pipeline?.backend === 'browser-wasm' ? pipeline.stream : raw;
								const audioContext = resources.own(new AudioContextClass(), (context) => context.close());
								const source = audioContext.createMediaStreamSource(outputStream);
								const analyser = audioContext.createAnalyser();
								const monitorGainNode = resources.own(audioContext.createGain(), (node) => node.disconnect());
								analyser.fftSize = ANALYSER_FFT_SIZE;
								analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
								monitorGainNode.gain.value = monitorEnabledRef.current ? 1 : 0;
								source.connect(analyser);
								source.connect(monitorGainNode);
								monitorGainNode.connect(audioContext.destination);
								monitorGainNodeRef.current = monitorGainNode;
								outputStreamRef.current = outputStream;
								return {
									audioContext,
									analyser,
									previewState:
										pipeline?.backend === 'browser-wasm' ? ('browser-wasm' as const) : ('browser-capture' as const),
								};
							},
							resume: async ({ audioContext }) => {
								if (audioContext.state !== 'running') await audioContext.resume();
							},
							onReady: ({ analyser, previewState }) => {
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
										Math.max(LEVEL_FLOOR, (rms / RMS_NORMALIZATION) * LEVEL_CEILING),
									);
									const coeff = targetLevel > displayLevel ? ATTACK_COEFF : RELEASE_COEFF;
									displayLevel += (targetLevel - displayLevel) * coeff;
									if (levelBarRef.current) {
										levelBarRef.current.style.width = `${displayLevel}%`;
									}
									animationFrameRef.current = requestAnimationFrame(updateInputLevel);
								};

								setTestPreviewState(previewState);
								updateInputLevel();
							},
						});
					} catch (error) {
						await resources.detach();
						if (!run.isCurrent()) return;
						setMicTestError(error instanceof Error ? error.message : 'Unable to access microphone for testing.');
						await stopTest();
					}
				})(),
			);
		}, [owner, resolvedMicProcessingConfig, resolveMicAudioConstraints, stopTest]);

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
					if (mediaRecorderRef.current !== recorder) return;
					if (event.data && event.data.size > 0) {
						recordingChunksRef.current.push(event.data);
					}
				};

				recorder.onerror = (event) => {
					if (mediaRecorderRef.current !== recorder) return;
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
					if (mediaRecorderRef.current !== recorder) return;
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
		const isTestingMicRef = useLatestRef(isTestingMic);

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
								className="h-full rounded-full bg-gradient-to-r from-success via-info to-primary transition-[width]"
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
													item.tone === 'warning' ? 'text-warning' : 'text-foreground'
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
										<Circle className="h-3 w-3 animate-pulse fill-destructive text-destructive" />
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
