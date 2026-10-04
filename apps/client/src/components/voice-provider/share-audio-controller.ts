import { StreamKind } from '@sharkord/shared';
import type { AppData, Producer, RtpParameters, Transport } from 'mediasoup-client/types';
import { getTrpcErrorData } from '@/helpers/trpc-error-data';
import { normalizeDesktopCapabilities } from '@/runtime/desktop-capabilities';
import {
	ScreenAudioMode,
	type TAppAudioSession,
	type TAppAudioStatusEvent,
	type TDesktopBridge,
	type TDesktopCapabilities,
	type TStartAppAudioCaptureInput,
} from '@/runtime/types';
import { getScreenShareAudioOpusConfig } from './audio-producer-config';
import type { TDesktopAppAudioPipeline, TDesktopAppAudioPipelineOptions } from './desktop-app-audio';
import {
	createDesktopAppAudioRecoveryController,
	type TDesktopAppAudioRecoveryLease,
} from './desktop-app-audio-recovery-controller';
import { VoiceSessionExecutionSupersededError } from './hooks/session-execution-ownership';

type TSrtpParameters = {
	cryptoSuite: 'AES_CM_128_HMAC_SHA1_80' | 'AES_CM_128_HMAC_SHA1_32' | 'AEAD_AES_256_GCM' | 'AEAD_AES_128_GCM';
	keyBase64: string;
};

type TShareAudioDependencies = {
	getDesktopBridge: () => TDesktopBridge | undefined;
	getProducerTransport: () => Transport<AppData> | undefined;
	isNativeIngestEnabled: () => boolean;
	isScreenVideoLive: () => boolean;
	createIngest: () => Promise<{
		id: string;
		ip: string;
		port: number;
		ssrc: number;
		rtpParameters: RtpParameters;
		srtpParameters: TSrtpParameters;
	}>;
	produceNative: (input: {
		transportId: string;
		srtpParameters: TSrtpParameters;
	}) => Promise<{ producerId: string } | { fallback: true }>;
	abortIngest: (transportId: string) => Promise<unknown>;
	closeProducer: (producerId?: string) => Promise<unknown>;
	createPipeline: (
		session: TAppAudioSession,
		options: TDesktopAppAudioPipelineOptions,
	) => Promise<TDesktopAppAudioPipeline>;
	createStream: (tracks: MediaStreamTrack[]) => MediaStream;
	publishStream: (stream: MediaStream | undefined) => void;
	warning: (message: string) => void;
	log: (message: string, data?: Record<string, unknown>) => void;
	setTimeout: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
};

type TAppAudioPublishIntent = {
	audioMode: ScreenAudioMode.APP | ScreenAudioMode.SYSTEM;
	captureInput: TStartAppAudioCaptureInput;
};

type TDesktopAppAudioWorkletStartResult =
	| { kind: 'published'; displayAudioTrack: undefined }
	| { kind: 'display-fallback'; displayAudioTrack: MediaStreamTrack }
	| { kind: 'abandoned'; displayAudioTrack: undefined }
	| { kind: 'none'; displayAudioTrack: undefined };

const getDesktopAudioIssueToastMessage = (
	capabilities: TDesktopCapabilities | undefined,
	audioMode: ScreenAudioMode,
) => {
	const affectedFeature = audioMode === ScreenAudioMode.SYSTEM ? 'system-audio' : 'per-app-audio';
	const relevantIssue =
		capabilities?.issues.find((issue) => {
			return issue.affects.includes(affectedFeature) && issue.severity === 'error';
		}) ??
		capabilities?.issues.find((issue) => {
			return issue.affects.includes(affectedFeature) && issue.severity === 'warning';
		});

	if (!relevantIssue) {
		return undefined;
	}

	return relevantIssue.guidance[0]
		? `${relevantIssue.title}: ${relevantIssue.guidance[0]}`
		: `${relevantIssue.title}: ${relevantIssue.message}`;
};

const isAuthDenialError = (error: unknown): boolean => {
	const code = getTrpcErrorData(error)?.code;

	return code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
};

const createShareAudioController = (deps: TShareAudioDependencies) => {
	let active = false;
	let lifecycleGeneration = 0;
	let operationGeneration = 0;
	let audioStream: MediaStream | undefined;
	let pendingDisplayStream: MediaStream | undefined;
	let audioProducer: Producer<AppData> | undefined;
	let pipeline: TDesktopAppAudioPipeline | undefined;
	let session: TAppAudioSession | undefined;
	let intent: TAppAudioPublishIntent | undefined;
	let nativeActive = false;
	let nativeProducerId: string | undefined;
	let nativeGeneration = 0;
	let workletGeneration = 0;
	let removeFrames: (() => void) | undefined;
	let removeStatus: (() => void) | undefined;
	let startupTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingCleanup: Promise<void> | undefined;
	const recoveryController = createDesktopAppAudioRecoveryController();
	const setLocalScreenShareAudio = (
		next: MediaStream | undefined | ((current: MediaStream | undefined) => MediaStream | undefined),
	): void => {
		audioStream = typeof next === 'function' ? next(audioStream) : next;
		deps.publishStream(audioStream);
	};
	const detachProducer = (): void => {
		const ownedProducer = audioProducer;
		audioProducer = undefined;
		ownedProducer?.close();
	};
	const publishScreenShareAudioTrack = async (
		stream: MediaStream,
		track: MediaStreamTrack,
		options: {
			onTrackEnded?: () => void | Promise<void>;
			isCurrent?: () => boolean;
		} = {},
	) => {
		const ownedLifecycle = lifecycleGeneration;
		const ownedOperation = operationGeneration;
		const ownsCapture = () =>
			active && lifecycleGeneration === ownedLifecycle && operationGeneration === ownedOperation;
		const ownsPublication = () => ownsCapture() && (!options.isCurrent || options.isCurrent());
		const transport = deps.getProducerTransport();
		if (!transport || transport.closed || !ownsPublication()) {
			throw new VoiceSessionExecutionSupersededError();
		}
		setLocalScreenShareAudio(stream);

		const screenAudioProducer = await transport.produce({
			track,
			stopTracks: false,
			...getScreenShareAudioOpusConfig(),
			appData: { kind: StreamKind.SCREEN_AUDIO },
		});

		if (deps.getProducerTransport() !== transport || transport.closed || !ownsPublication()) {
			screenAudioProducer.close();
			throw new VoiceSessionExecutionSupersededError();
		}

		audioProducer = screenAudioProducer;

		screenAudioProducer.on('@close', () => {
			deps.log('Screen share audio producer closed', { producerId: screenAudioProducer.id });
			if (audioProducer === screenAudioProducer) audioProducer = undefined;
			void deps
				.closeProducer(screenAudioProducer.id)
				.catch((error) => deps.log('Error closing producer on server', { error, producerId: screenAudioProducer.id }));
		});

		const onTrackEnded = () => {
			// A completed session command may expire its publication lease. Track
			// cleanup belongs to capture identity, and survives producer detachment.
			if (!ownsCapture() || track.onended !== onTrackEnded || audioStream !== stream) return;
			screenAudioProducer.close();

			if (audioProducer === screenAudioProducer) {
				audioProducer = undefined;
			}

			setLocalScreenShareAudio((currentStream) => {
				return currentStream === stream ? undefined : currentStream;
			});

			void options.onTrackEnded?.();
		};
		track.onended = onTrackEnded;

		return screenAudioProducer;
	};
	const cleanupDesktopAppAudio = async ({
		stopCapture = true,
		preserveCurrentAudio = false,
	}: {
		stopCapture?: boolean;
		preserveCurrentAudio?: boolean;
	} = {}) => {
		const desktopBridge = deps.getDesktopBridge();
		// Detach everything this cleanup owns before its first await. A newer
		// capture can then install replacement resources without an older cleanup
		// reading or clearing them after it resumes.
		const startupTimeout = startupTimer;
		startupTimer = undefined;
		const removeFrameSubscription = removeFrames;
		removeFrames = undefined;
		const removeStatusSubscription = removeStatus;
		removeStatus = undefined;
		const nativeIngestWasActive = nativeActive;
		const ownedNativeProducerId = nativeProducerId;
		nativeProducerId = undefined;
		nativeActive = false;
		const activeSession = session;
		session = undefined;
		const appAudioPipeline = pipeline;
		pipeline = undefined;
		const ownedAudioStream = audioStream;

		if (startupTimeout !== undefined) {
			deps.clearTimeout(startupTimeout);
		}

		removeFrameSubscription?.();
		removeStatusSubscription?.();

		const previousCleanup = pendingCleanup;
		const cleanupPromise = (async () => {
			await previousCleanup?.catch(() => undefined);
			// Native RTP ingest teardown: stop the main-process Opus/SRTP sender and
			// ask the server to close the SCREEN_AUDIO producer (which also releases
			// its PlainTransport). The worklet pipeline below is never built on this
			// path, so it is a no-op for native ingest.
			if (nativeIngestWasActive) {
				try {
					await desktopBridge?.stopAppAudioRtp?.();
				} catch (error) {
					deps.log('Failed to stop native app audio RTP sender', { error });
				}

				try {
					await deps.closeProducer(ownedNativeProducerId);
				} catch (error) {
					deps.log('Failed to close native app audio producer on server', { error });
				}
			}

			if (stopCapture && desktopBridge && activeSession?.sessionId) {
				try {
					await desktopBridge.stopAppAudioCapture(activeSession.sessionId);
				} catch (error) {
					deps.log('Failed to stop desktop app audio capture', { error });
				}
			}

			if (appAudioPipeline) {
				await appAudioPipeline.destroy().catch((error) => {
					deps.log('Failed to clean up desktop app audio pipeline', { error });
				});
			}

			if (!preserveCurrentAudio) {
				setLocalScreenShareAudio((currentStream) => {
					return currentStream === ownedAudioStream ? undefined : currentStream;
				});
			}
		})().finally(() => {
			if (pendingCleanup === cleanupPromise) pendingCleanup = undefined;
		});
		pendingCleanup = cleanupPromise;
		await cleanupPromise;
	};
	const startNativeAppAudioIngest = async ({
		desktopBridge,
		captureInput,
		audioMode,
		isCurrent = () => true,
	}: {
		desktopBridge: TDesktopBridge;
		captureInput: TStartAppAudioCaptureInput;
		audioMode: ScreenAudioMode.APP | ScreenAudioMode.SYSTEM;
		isCurrent?: () => boolean;
	}): Promise<'published' | 'abandoned' | 'fallback'> => {
		const startAppAudioRtp = desktopBridge.startAppAudioRtp;
		const stopAppAudioRtp = desktopBridge.stopAppAudioRtp;
		if (!isCurrent()) {
			return 'abandoned';
		}

		// Capability gate: only newer desktop builds expose the native RTP bridge.
		if (typeof startAppAudioRtp !== 'function' || typeof stopAppAudioRtp !== 'function') {
			deps.log('Native app audio ingest unavailable (bridge missing); using worklet path');
			return 'fallback';
		}

		// Rollout gate: opt-in until validated end-to-end and in a packaged build.
		if (!deps.isNativeIngestEnabled()) {
			deps.log('Native app audio ingest disabled; using worklet path');
			return 'fallback';
		}

		// Claim this attempt's generation. Shared/global state is only ours to
		// tear down while we remain the current attempt.
		const attemptGeneration = ++nativeGeneration;
		const attemptPublishIntent = intent;
		const ownsCurrentAttempt = () => nativeGeneration === attemptGeneration;
		const ownsPublishIntent = () =>
			isCurrent() && ownsCurrentAttempt() && attemptPublishIntent !== undefined && intent === attemptPublishIntent;
		const nativeAudioLabel = audioMode === ScreenAudioMode.SYSTEM ? 'System audio' : 'Per-app audio';

		let captureStarted = false;
		// Captured from this attempt's own session/ingest rather than read from
		// shared refs at teardown time, so we never stop a newer attempt's
		// capture or abort a newer attempt's server ingest.
		let attemptSession: TAppAudioSession | undefined;
		let attemptSessionId: string | undefined;
		let attemptTransportId: string | undefined;
		let attemptRemoveStatusSubscription: (() => void) | undefined;

		const teardownNativeAttempt = async () => {
			const ownsGlobalState = ownsCurrentAttempt();

			// The singleton RTP sender and the session/active refs belong to the
			// newest attempt; only touch them if no newer attempt has superseded us.
			if (ownsGlobalState) {
				try {
					await stopAppAudioRtp();
				} catch (error) {
					deps.log('Failed to stop native app audio RTP sender during teardown', { error });
				}
			}

			if (captureStarted && attemptSessionId) {
				try {
					await desktopBridge.stopAppAudioCapture(attemptSessionId);
				} catch (error) {
					deps.log('Failed to stop native app audio capture during teardown', { error });
				}
			}

			// Release the server-side PlainTransport for an ingest that was created
			// but never published; scoped by transport id so it is a no-op once a
			// newer attempt has replaced the ingest. Without this the UDP port leaks
			// until leave or the next native attempt.
			if (attemptTransportId) {
				try {
					await deps.abortIngest(attemptTransportId);
				} catch (error) {
					deps.log('Failed to abort native app audio ingest during teardown', { error });
				}
			}

			attemptRemoveStatusSubscription?.();
			if (removeStatus === attemptRemoveStatusSubscription) {
				removeStatus = undefined;
			}
			if (session === attemptSession) {
				session = undefined;
			}
			if (ownsGlobalState) {
				nativeActive = false;
			}
		};

		let fallbackReason: 'no-first-media' | 'error' = 'error';

		try {
			// Capture without the renderer worklet frame channel: the desktop main
			// process consumes the PCM egress and feeds the RTP sender directly.
			const capturedSession = await desktopBridge.startAppAudioCapture(captureInput, { openFrameChannel: false });
			attemptSession = capturedSession;
			attemptSessionId = capturedSession.sessionId;
			captureStarted = true;
			if (!ownsPublishIntent()) {
				deps.log('Native app audio ingest abandoned after capture; tearing down', {
					sessionId: capturedSession.sessionId,
					superseded: !ownsCurrentAttempt(),
				});
				await teardownNativeAttempt();
				return 'abandoned';
			}

			session = capturedSession;
			removeStatus?.();
			attemptRemoveStatusSubscription = desktopBridge.subscribeAppAudioStatus((statusEvent: TAppAudioStatusEvent) => {
				deps.log('Received native app audio status event', {
					sessionId: statusEvent.sessionId,
					targetId: statusEvent.targetId,
					reason: statusEvent.reason,
					error: statusEvent.error,
				});
				if (
					statusEvent.sessionId !== capturedSession.sessionId ||
					statusEvent.sessionId !== session?.sessionId ||
					!ownsPublishIntent() ||
					!nativeActive
				) {
					return;
				}

				void (async () => {
					deps.warning(
						statusEvent.error
							? `${nativeAudioLabel} capture ended (${statusEvent.reason}): ${statusEvent.error}`
							: `${nativeAudioLabel} capture ended (${statusEvent.reason}). Screen video will continue without shared audio.`,
					);
					audioProducer?.close();
					audioProducer = undefined;
					setLocalScreenShareAudio(undefined);

					await cleanupDesktopAppAudio({
						stopCapture: false,
						preserveCurrentAudio: false,
					});
				})();
			});
			removeStatus = attemptRemoveStatusSubscription;

			const ingest = await deps.createIngest();
			attemptTransportId = ingest.id;
			if (!ownsPublishIntent()) {
				deps.log('Native app audio ingest abandoned after ingest allocation; tearing down', {
					transportId: ingest.id,
					superseded: !ownsCurrentAttempt(),
				});
				await teardownNativeAttempt();
				return 'abandoned';
			}

			const { srtpKeyBase64 } = await startAppAudioRtp({
				ip: ingest.ip,
				port: ingest.port,
				ssrc: ingest.ssrc,
				payloadType: ingest.rtpParameters.codecs?.[0]?.payloadType,
			});
			if (!ownsPublishIntent()) {
				deps.log('Native app audio ingest abandoned after RTP sender start; tearing down', {
					transportId: ingest.id,
					superseded: !ownsCurrentAttempt(),
				});
				await teardownNativeAttempt();
				return 'abandoned';
			}

			const result = await deps.produceNative({
				transportId: ingest.id,
				srtpParameters: {
					cryptoSuite: ingest.srtpParameters.cryptoSuite,
					keyBase64: srtpKeyBase64,
				},
			});

			if ('producerId' in result) {
				// The attempt can be abandoned while produceAppAudio is in flight: the
				// user stops the share (clearing intent) or a newer
				// attempt supersedes this generation. cleanupDesktopAppAudio gates its
				// native teardown on nativeActive, which is still false
				// until the line below, so committing here would strand a live
				// SCREEN_AUDIO producer plus a running RTP sender/UDP socket that the
				// stop-path cleanup already skipped. Tear our own attempt down instead.
				if (!ownsPublishIntent()) {
					deps.log('Native app audio ingest abandoned after produce; tearing down', {
						producerId: result.producerId,
						superseded: !ownsCurrentAttempt(),
					});
					await teardownNativeAttempt();
					return 'abandoned';
				}

				nativeActive = true;
				nativeProducerId = result.producerId;
				deps.log('Native app audio ingest active', { producerId: result.producerId });
				return 'published';
			}

			// Operational fallback: server observed no first media within the gate.
			fallbackReason = 'no-first-media';
		} catch (error) {
			if (!ownsPublishIntent()) {
				await teardownNativeAttempt();
				return 'abandoned';
			}

			// Authorization denial is hard and must NEVER fall back to the worklet
			// path — that path also produces SCREEN_AUDIO and would escape the
			// SHARE_SCREEN gate. Tear down the attempt and rethrow.
			if (isAuthDenialError(error)) {
				await teardownNativeAttempt();
				deps.log('Native app audio ingest denied (auth); not falling back', {
					code: getTrpcErrorData(error)?.code,
				});
				throw error;
			}

			deps.log('Native app audio ingest attempt errored; falling back to worklet', {
				error,
				code: getTrpcErrorData(error)?.code,
			});
		}

		// Operational fallback: clean up the native attempt and let the caller use
		// the worklet path. The single binary egress is left with no native sink.
		await teardownNativeAttempt();
		if (!ownsPublishIntent()) {
			return 'abandoned';
		}
		deps.log('Native app audio ingest falling back to worklet path', { reason: fallbackReason });

		return 'fallback';
	};
	const startDesktopAppAudioWorklet = async ({
		desktopBridge,
		captureInput,
		audioMode,
		displayStream,
		displayAudioTrack,
		showWarnings = true,
		isCurrent = () => true,
	}: {
		desktopBridge: TDesktopBridge;
		captureInput: TStartAppAudioCaptureInput;
		audioMode: ScreenAudioMode.APP | ScreenAudioMode.SYSTEM;
		displayStream?: MediaStream;
		displayAudioTrack?: MediaStreamTrack;
		showWarnings?: boolean;
		isCurrent?: () => boolean;
	}): Promise<TDesktopAppAudioWorkletStartResult> => {
		const sidecarAudioLabel = audioMode === ScreenAudioMode.SYSTEM ? 'System audio' : 'Per-app audio';
		const attemptGeneration = ++workletGeneration;
		const attemptPublishIntent = intent;
		const ownsAttempt = () =>
			isCurrent() &&
			workletGeneration === attemptGeneration &&
			attemptPublishIntent !== undefined &&
			intent === attemptPublishIntent;
		let appAudioSession: TAppAudioSession | undefined;
		let appAudioPipeline: TDesktopAppAudioPipeline | undefined;
		let screenAudioProducer: Producer<AppData> | undefined;
		let removeFrameSubscription: (() => void) | undefined;
		let removeStatusSubscription: (() => void) | undefined;
		let startupTimeout: ReturnType<typeof setTimeout> | undefined;

		const teardownWorkletAttempt = async (): Promise<void> => {
			if (startupTimeout !== undefined) {
				deps.clearTimeout(startupTimeout);
				if (startupTimer === startupTimeout) {
					startupTimer = undefined;
				}
				startupTimeout = undefined;
			}

			removeFrameSubscription?.();
			if (removeFrames === removeFrameSubscription) {
				removeFrames = undefined;
			}
			removeFrameSubscription = undefined;

			removeStatusSubscription?.();
			if (removeStatus === removeStatusSubscription) {
				removeStatus = undefined;
			}
			removeStatusSubscription = undefined;

			if (screenAudioProducer) {
				screenAudioProducer.close();
				if (audioProducer === screenAudioProducer) {
					audioProducer = undefined;
				}
			}

			if (pipeline === appAudioPipeline) {
				pipeline = undefined;
			}
			if (session === appAudioSession) {
				session = undefined;
			}

			const ownedPipeline = appAudioPipeline;
			appAudioPipeline = undefined;
			if (ownedPipeline) {
				ownedPipeline.track.onended = null;
				await ownedPipeline.destroy().catch((error) => {
					deps.log('Failed to clean up desktop app audio pipeline attempt', { error });
				});
				setLocalScreenShareAudio((currentStream) =>
					currentStream === ownedPipeline.stream ? undefined : currentStream,
				);
			}

			const ownedSession = appAudioSession;
			appAudioSession = undefined;
			if (ownedSession) {
				try {
					await desktopBridge.stopAppAudioCapture(ownedSession.sessionId);
				} catch (error) {
					deps.log('Failed to stop desktop app audio capture attempt', { error });
				}
			}
		};

		if (!ownsAttempt()) {
			return { kind: 'abandoned', displayAudioTrack: undefined };
		}

		try {
			deps.log('Starting sidecar audio capture', {
				sourceId: captureInput.sourceId,
				appAudioTargetId: captureInput.appAudioTargetId,
				mode: audioMode === ScreenAudioMode.SYSTEM ? 'system-exclude' : 'per-app',
			});
			appAudioSession = await desktopBridge.startAppAudioCapture(captureInput);
			deps.log('Sidecar capture started', {
				sessionId: appAudioSession.sessionId,
				targetId: appAudioSession.targetId,
			});
			if (!ownsAttempt()) {
				await teardownWorkletAttempt();
				return { kind: 'abandoned', displayAudioTrack: undefined };
			}

			appAudioPipeline = await deps.createPipeline(appAudioSession, {
				mode: 'stable',
				logLabel: audioMode === ScreenAudioMode.SYSTEM ? 'system-audio' : 'per-app-audio',
				insertSilenceOnDroppedFrames: true,
			});
			if (!ownsAttempt()) {
				await teardownWorkletAttempt();
				return { kind: 'abandoned', displayAudioTrack: undefined };
			}

			let hasReceivedSessionFrame = false;

			removeFrameSubscription = desktopBridge.subscribeAppAudioFrames((frame) => {
				if (!ownsAttempt() || frame.sessionId !== appAudioSession?.sessionId) {
					return;
				}

				if (!hasReceivedSessionFrame) {
					deps.log('Received first sidecar audio frame', {
						sessionId: frame.sessionId,
						targetId: frame.targetId,
					});
				}

				hasReceivedSessionFrame = true;
				if (startupTimeout !== undefined) {
					deps.clearTimeout(startupTimeout);
					if (startupTimer === startupTimeout) {
						startupTimer = undefined;
					}
					startupTimeout = undefined;
				}
				appAudioPipeline?.pushFrame(frame);
			});

			removeStatusSubscription = desktopBridge.subscribeAppAudioStatus((statusEvent: TAppAudioStatusEvent) => {
				deps.log('Received sidecar audio status event', {
					sessionId: statusEvent.sessionId,
					targetId: statusEvent.targetId,
					reason: statusEvent.reason,
					error: statusEvent.error,
				});
				if (!ownsAttempt() || statusEvent.sessionId !== appAudioSession?.sessionId || session !== appAudioSession) {
					return;
				}

				void (async () => {
					if (startupTimer !== undefined) {
						deps.clearTimeout(startupTimer);
						startupTimer = undefined;
					}
					if (showWarnings) {
						deps.warning(
							statusEvent.error
								? `${sidecarAudioLabel} capture ended (${statusEvent.reason}): ${statusEvent.error}`
								: `${sidecarAudioLabel} capture ended (${statusEvent.reason}). Screen video will continue without shared audio.`,
						);
					}
					audioProducer?.close();
					audioProducer = undefined;
					setLocalScreenShareAudio(undefined);

					await cleanupDesktopAppAudio({
						stopCapture: false,
						preserveCurrentAudio: false,
					});
				})();
			});

			const appAudioTrack = appAudioPipeline.track;
			screenAudioProducer = await publishScreenShareAudioTrack(appAudioPipeline.stream, appAudioTrack, {
				isCurrent: ownsAttempt,
				onTrackEnded: () => {
					if (pipeline !== appAudioPipeline) {
						return;
					}
					return cleanupDesktopAppAudio({
						stopCapture: false,
					});
				},
			});
			if (!ownsAttempt()) {
				await teardownWorkletAttempt();
				return { kind: 'abandoned', displayAudioTrack: undefined };
			}

			session = appAudioSession;
			pipeline = appAudioPipeline;
			removeFrames?.();
			removeFrames = removeFrameSubscription;
			removeStatus?.();
			removeStatus = removeStatusSubscription;
			startupTimeout = deps.setTimeout(() => {
				if (hasReceivedSessionFrame || !ownsAttempt() || session !== appAudioSession) {
					return;
				}

				deps.log('Sidecar produced no audio frames after startup', {
					sessionId: appAudioSession?.sessionId,
					targetId: appAudioSession?.targetId,
				});
				if (showWarnings) {
					deps.warning(
						`${sidecarAudioLabel} started but produced no audio frames. Screen video will continue without shared audio.`,
					);
				}
				audioProducer?.close();
				audioProducer = undefined;
				setLocalScreenShareAudio(undefined);
				void cleanupDesktopAppAudio({
					stopCapture: true,
					preserveCurrentAudio: false,
				});
			}, 3000);
			startupTimer = startupTimeout;

			if (displayAudioTrack) {
				displayAudioTrack.stop();
				displayStream?.removeTrack(displayAudioTrack);
			}

			return { kind: 'published', displayAudioTrack: undefined };
		} catch (error) {
			await teardownWorkletAttempt();
			if (!ownsAttempt()) {
				return { kind: 'abandoned', displayAudioTrack: undefined };
			}

			deps.log('Failed to start sidecar audio capture', {
				error,
			});
			const capabilities = await desktopBridge
				.getCapabilities()
				.then((nextCapabilities) => normalizeDesktopCapabilities(nextCapabilities))
				.catch(() => undefined);
			if (!ownsAttempt()) {
				return { kind: 'abandoned', displayAudioTrack: undefined };
			}
			const issueToastMessage = getDesktopAudioIssueToastMessage(capabilities, audioMode);

			if (audioMode === ScreenAudioMode.SYSTEM && displayAudioTrack?.readyState === 'live') {
				deps.log('Falling back to display-media loopback for system audio');
				if (showWarnings) {
					deps.warning(
						issueToastMessage
							? `${issueToastMessage} Falling back to standard system audio (without echo exclusion).`
							: 'Sidecar audio capture failed. Falling back to standard system audio (without echo exclusion).',
					);
				}

				return { kind: 'display-fallback', displayAudioTrack };
			}

			if (showWarnings) {
				deps.warning(
					issueToastMessage
						? `${issueToastMessage} Continuing without shared audio.`
						: `${sidecarAudioLabel} capture failed. Continuing without shared audio.`,
				);
			}

			if (displayAudioTrack) {
				displayAudioTrack.stop();
				displayStream?.removeTrack(displayAudioTrack);
			}

			return { kind: 'none', displayAudioTrack: undefined };
		}
	};
	const runDesktopAppAudioRecovery = async (lease: TDesktopAppAudioRecoveryLease): Promise<void> => {
		const recoveryIntent = intent;
		const ownsRecovery = () => lease.isCurrent() && intent === recoveryIntent;

		if (!recoveryIntent || !ownsRecovery()) {
			return;
		}

		const desktopBridge = deps.getDesktopBridge();
		if (!desktopBridge) {
			deps.log('Skipping desktop app audio recovery because desktop bridge is unavailable');
			return;
		}

		if (!deps.isScreenVideoLive()) {
			deps.log('Skipping desktop app audio recovery because screen share is no longer live');
			intent = undefined;
			return;
		}

		const currentScreenShareAudioStream = audioStream;
		const currentScreenShareAudioTrack = currentScreenShareAudioStream?.getAudioTracks()[0];
		const currentPipelineTrack = pipeline?.track;
		const displayFallbackTrack =
			currentScreenShareAudioTrack &&
			currentScreenShareAudioTrack.readyState === 'live' &&
			currentScreenShareAudioTrack !== currentPipelineTrack
				? currentScreenShareAudioTrack
				: undefined;

		deps.log('Recovering desktop app audio from publish intent', {
			sourceId: recoveryIntent.captureInput.sourceId,
			appAudioTargetId: recoveryIntent.captureInput.appAudioTargetId,
			mode: recoveryIntent.audioMode === ScreenAudioMode.SYSTEM ? 'system-exclude' : 'per-app',
			hasDisplayFallbackTrack: displayFallbackTrack !== undefined,
		});

		audioProducer?.close();
		audioProducer = undefined;

		await cleanupDesktopAppAudio({
			stopCapture: true,
			preserveCurrentAudio: false,
		});
		if (!ownsRecovery()) {
			return;
		}

		const captureInput = { ...recoveryIntent.captureInput };
		const nativeIngestResult = await startNativeAppAudioIngest({
			desktopBridge,
			captureInput,
			audioMode: recoveryIntent.audioMode,
			isCurrent: ownsRecovery,
		});

		if (nativeIngestResult === 'published' || nativeIngestResult === 'abandoned') {
			// 'published': native owns SCREEN_AUDIO. 'abandoned': the attempt tore
			// itself down because the intent was cleared/superseded mid-recovery.
			// Either way do not fall back to the worklet path.
			if (ownsRecovery()) {
				setLocalScreenShareAudio(undefined);
			} else if (nativeIngestResult === 'published') {
				await cleanupDesktopAppAudio();
			}
			return;
		}
		if (!ownsRecovery()) {
			return;
		}

		const workletResult = await startDesktopAppAudioWorklet({
			desktopBridge,
			captureInput,
			audioMode: recoveryIntent.audioMode,
			displayStream: currentScreenShareAudioStream,
			displayAudioTrack: displayFallbackTrack,
			showWarnings: false,
			isCurrent: ownsRecovery,
		});

		if (workletResult.kind === 'display-fallback') {
			if (!ownsRecovery()) {
				return;
			}
			deps.log('Recovering desktop app audio with display-media loopback fallback');
			const fallbackStream = deps.createStream([workletResult.displayAudioTrack]);
			try {
				await publishScreenShareAudioTrack(fallbackStream, workletResult.displayAudioTrack, {
					isCurrent: ownsRecovery,
				});
			} catch (error) {
				setLocalScreenShareAudio((currentStream) => (currentStream === fallbackStream ? undefined : currentStream));
				throw error;
			}
			return;
		}

		if (workletResult.kind === 'none') {
			deps.log('Desktop app audio recovery completed without a recoverable audio path');
		}
	};

	// Screen capture hands over audio immediately, before video publication. This
	// also owns audio if video publication fails before optional audio startup.
	const adoptDisplayAudio = (stream: MediaStream): void => {
		pendingDisplayStream = stream;
	};
	const awaitTeardown = async (): Promise<void> => {
		await pendingCleanup;
	};
	const stopAudioTracks = (stream: MediaStream | undefined): void => {
		stream?.getAudioTracks().forEach((track) => {
			track.stop();
			stream.removeTrack(track);
		});
	};
	const stop = (): Promise<void> => {
		operationGeneration += 1;
		intent = undefined;
		detachProducer();
		stopAudioTracks(audioStream);
		stopAudioTracks(pendingDisplayStream);
		pendingDisplayStream = undefined;
		const cleanup = cleanupDesktopAppAudio();
		setLocalScreenShareAudio(undefined);
		return cleanup;
	};
	const activate = (): void => {
		if (active) return;
		active = true;
		lifecycleGeneration += 1;
		recoveryController.activate();
	};
	const deactivate = (): void => {
		if (!active) return;
		active = false;
		lifecycleGeneration += 1;
		recoveryController.deactivate();
		void stop();
	};
	const start = async ({
		displayStream,
		desktopBridge,
		captureInput,
		audioMode,
	}: {
		displayStream: MediaStream;
		desktopBridge?: TDesktopBridge;
		captureInput?: TStartAppAudioCaptureInput;
		audioMode?: ScreenAudioMode.APP | ScreenAudioMode.SYSTEM;
	}): Promise<'published' | 'abandoned' | 'none'> => {
		const ownedOperation = ++operationGeneration;
		const ownedLifecycle = lifecycleGeneration;
		const isCurrent = () =>
			active &&
			lifecycleGeneration === ownedLifecycle &&
			operationGeneration === ownedOperation &&
			deps.isScreenVideoLive();
		pendingDisplayStream = displayStream;
		await awaitTeardown();
		if (!isCurrent()) {
			stopAudioTracks(displayStream);
			return 'abandoned';
		}
		let displayAudioTrack: MediaStreamTrack | undefined = displayStream.getAudioTracks()[0];
		try {
			if (desktopBridge && captureInput && audioMode) {
				intent = { audioMode, captureInput: { ...captureInput } };
				const nativeResult = await startNativeAppAudioIngest({ desktopBridge, captureInput, audioMode, isCurrent });
				if (nativeResult === 'published' || nativeResult === 'abandoned') {
					stopAudioTracks(displayStream);
					return nativeResult;
				}
				const workletResult = await startDesktopAppAudioWorklet({
					desktopBridge,
					captureInput,
					audioMode,
					displayStream,
					displayAudioTrack,
					isCurrent,
				});
				if (workletResult.kind === 'abandoned') {
					stopAudioTracks(displayStream);
					return 'abandoned';
				}
				if (workletResult.kind === 'published') return 'published';
				displayAudioTrack = workletResult.displayAudioTrack;
			} else {
				intent = undefined;
			}
			if (!isCurrent()) {
				stopAudioTracks(displayStream);
				return 'abandoned';
			}
			if (displayAudioTrack) {
				deps.log('Obtained audio track', { audioTrack: displayAudioTrack });
				await publishScreenShareAudioTrack(deps.createStream([displayAudioTrack]), displayAudioTrack, { isCurrent });
				return 'published';
			}
			await cleanupDesktopAppAudio();
			if (isCurrent()) setLocalScreenShareAudio(undefined);
			return 'none';
		} catch (error) {
			if (!isCurrent()) {
				stopAudioTracks(displayStream);
				return 'abandoned';
			}
			await stop();
			throw error;
		} finally {
			if (pendingDisplayStream === displayStream) pendingDisplayStream = undefined;
		}
	};
	const republish = (isCurrent?: () => boolean): Promise<void> | undefined => {
		const stream = audioStream;
		const track = stream?.getAudioTracks()[0];
		if (intent || !stream || !track || track.readyState !== 'live') return undefined;
		return publishScreenShareAudioTrack(stream, track, {
			isCurrent,
			onTrackEnded: pipeline?.track === track ? () => cleanupDesktopAppAudio({ stopCapture: false }) : undefined,
		}).then(() => undefined);
	};
	return {
		activate,
		deactivate,
		adoptDisplayAudio,
		start,
		stop,
		detachProducer,
		awaitTeardown,
		republish,
		recover: () => recoveryController.recover(runDesktopAppAudioRecovery),
		hasDesktopIntent: () => intent !== undefined,
	};
};

type TShareAudioController = ReturnType<typeof createShareAudioController>;
const mountShareAudioController = (controller: TShareAudioController): (() => void) => {
	controller.activate();
	let mounted = true;
	return () => {
		if (!mounted) return;
		mounted = false;
		controller.deactivate();
	};
};

export {
	createShareAudioController,
	mountShareAudioController,
	type TShareAudioController,
	type TShareAudioDependencies,
};
