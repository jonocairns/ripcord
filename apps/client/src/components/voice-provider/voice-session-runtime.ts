import type {
	TRemoteProducerIds,
	TTransportParams,
	TVoiceTransportFailureEvent,
	TVoiceUserState,
} from '@sharkord/shared';
import type { Device, RtpCapabilities } from 'mediasoup-client/types';
import type {
	TVoiceSessionRebuildContext,
	TVoiceSessionRestoreContext,
} from '@/features/server/voice/voice-session-command-executor';
import type {
	TTransportRecoveryTransition,
	TVoiceSessionCommand,
	TWatchedRemoteStreamsSnapshot,
} from '@/features/server/voice/voice-session-machine';
import type {
	dispatchVoiceSession,
	dispatchVoiceSessionWithResult,
	getVoiceSessionState,
} from '@/features/server/voice/voice-session-store';
import {
	claimVoiceSessionExecution,
	createVoiceSessionExecutionOwnership,
	invalidateVoiceSessionExecution,
	VoiceSessionExecutionSupersededError,
} from './hooks/session-execution-ownership';
import type { useTransportStats } from './hooks/use-transport-stats';
import type { useTransports } from './hooks/use-transports';
import type { createMicrophoneIntegration } from './microphone-integration';
import type { TMicrophonePreparedPipeline } from './microphone-pipeline-controller';
import type { createScreenShareController } from './screen-share-controller';
import type { TShareAudioController } from './share-audio-controller';
import {
	recordTransportRecoverySucceeded,
	resolveTransportFailureDispatchOutcome,
	resolveTransportRecoveryCircuitDecision,
	type TTransportRecoveryCircuitState,
} from './transport-recovery-circuit';
import { recoverTransportMicrophone } from './transport-recovery-microphone';
import type { TRepublishedLocalMediaState } from './types';
import type { createWebcamController } from './webcam-controller';

type TRecoveryJoinResult = {
	device: Device;
	routerRtpCapabilities: RtpCapabilities;
	channelUsers: Array<{ userId: number; state: TVoiceUserState }>;
	existingProducers?: TRemoteProducerIds;
	producerTransportParams?: TTransportParams;
	consumerTransportParams?: TTransportParams;
};

type TVoiceBootstrapResult = {
	routerRtpCapabilities: RtpCapabilities;
	channelUsers: Array<{ userId: number; state: TVoiceUserState }>;
	existingProducers?: TRemoteProducerIds;
	producerTransportParams?: TTransportParams;
	consumerTransportParams?: TTransportParams;
};

type TLocalMediaRepublishPlan = {
	tasks: Promise<void>[];
	state: TRepublishedLocalMediaState;
};

type TVoiceSessionRuntimeDependencies = Pick<
	ReturnType<typeof useTransports>,
	'createProducerTransport' | 'createConsumerTransport' | 'consumeExistingProducers' | 'cleanupTransports'
> &
	Pick<ReturnType<typeof useTransportStats>, 'startMonitoring' | 'stopMonitoring' | 'resetStats'> & {
		microphone: Pick<
			ReturnType<typeof createMicrophoneIntegration>,
			'createLifecycleLease' | 'prepare' | 'publish' | 'start' | 'cleanup' | 'owns'
		>;
		webcam: Pick<ReturnType<typeof createWebcamController>, 'stop' | 'detachProducer' | 'republish'>;
		screenShare: Pick<ReturnType<typeof createScreenShareController>, 'stop' | 'detachProducer' | 'republish'>;
		shareAudio: Pick<TShareAudioController, 'detachProducer' | 'republish' | 'recover' | 'hasDesktopIntent'>;
		getChannelId: () => number | undefined;
		isConnected: () => boolean;
		getReconnectNonce: () => number;
		canSpeak: () => boolean;
		getLocalAudioStream: () => MediaStream | undefined;
		getProducerTransport: () => ReturnType<typeof useTransports>['producerTransport']['current'];
		getConsumerTransport: () => ReturnType<typeof useTransports>['consumerTransport']['current'];
		getOwnVoiceState: () => TVoiceUserState;
		getServerState: () => {
			connected: boolean;
			setCurrentVoiceChannelId: (id: number | undefined) => void;
			updateOwnVoiceState: (state: Partial<TVoiceUserState>) => void;
			setPinnedCard: (card: undefined) => void;
			reconcileVoiceChannelUsers: (input: { channelId: number; users: TRecoveryJoinResult['channelUsers'] }) => void;
			bumpVoiceSessionReconnectNonce: () => void;
		};
		createDevice: () => Promise<Device>;
		requestVoiceRestoreOrJoin: (options: {
			channelId: number;
			micMuted: boolean;
			soundMuted: boolean;
			reconnectAttemptId: string;
			signal?: AbortSignal;
		}) => Promise<TVoiceBootstrapResult>;
		sendOwnVoiceStateUpdate: (
			state: TRepublishedLocalMediaState,
			options: { signal?: AbortSignal },
		) => Promise<unknown>;
		updateOwnVoiceState: (state: TRepublishedLocalMediaState) => void;
		clearOwnVoiceSessionAfterReconnectFailure: (
			reason: Extract<TVoiceSessionCommand, { type: 'ClearFailedSession' }>['reason'],
		) => void;
		leaveVoiceSessionAfterRecoveryFailure: () => Promise<boolean>;
		notifyConnectionLost: () => void;
		commitTerminalMicMuted: () => void;
		clearRemoteUserStreams: () => void;
		clearExternalStreams: () => void;
		clearMediaElementRefs: () => void;
		clearActivity: () => void;
		publishRtpCapabilities: (capabilities: RtpCapabilities | null) => void;
		rehydrateWatchIntentOnly: (snapshot: TWatchedRemoteStreamsSnapshot) => void;
		captureWatchedRemoteStreams: () => TWatchedRemoteStreamsSnapshot;
		dispatchVoiceSession: typeof dispatchVoiceSession;
		dispatchVoiceSessionWithResult: typeof dispatchVoiceSessionWithResult;
		getVoiceSessionState: typeof getVoiceSessionState;
		logVoice: (message: string, data?: Record<string, unknown>) => void;
		logDebug: (message: string, data?: Record<string, unknown>) => void;
		traceSentrySpan: <T>(
			context: { name: string; op: string; attributes: Record<string, string | number | boolean> },
			effect: () => Promise<T>,
		) => Promise<T>;
		now: () => number;
		createReconnectAttemptId: () => string;
		getErrorCode: (error: unknown) => string | undefined;
		withRecoveryTimeout: <T>(operation: Promise<T>) => Promise<T>;
		waitForProducerRefresh: () => Promise<void>;
	};

type TVoiceSessionRuntimeInitOptions = {
	producerTransportParams?: TTransportParams;
	consumerTransportParams?: TTransportParams;
	existingProducers?: TRemoteProducerIds;
	// Keep live webcam/screen-share capture alive across the teardown and
	// republish it onto the new transport (WS-reconnect restore). Without
	// this an in-progress screen share is silently dropped on reconnect.
	preserveLocalMedia?: boolean;
	restoreWatchSnapshot?: TWatchedRemoteStreamsSnapshot;
	isCurrentRecovery?: () => boolean;
};

// Concrete session effects coordinate resource owners. The machine and executor
// retain phase, command, retry, scheduling and bounded-drain ownership.
const createVoiceSessionRuntime = (getDependencies: () => TVoiceSessionRuntimeDependencies) => {
	let currentDevice: Device | undefined;
	let routerCapabilities: RtpCapabilities | null = null;
	let sendCapabilities: RtpCapabilities | null = null;
	let hasHandledTransportFailure = false;
	let transportRecoveryCircuit: TTransportRecoveryCircuitState | undefined;
	const executionOwnership = createVoiceSessionExecutionOwnership();
	let active = false;
	const activate = (): void => {
		active = true;
	};
	const deactivate = (): void => {
		active = false;
		invalidateVoiceSessionExecution(executionOwnership);
	};
	const onTransportFailure = (failure?: TVoiceTransportFailureEvent) => {
		if (!active) return;
		if (hasHandledTransportFailure) {
			getDependencies().logVoice('Transport failure already handled, skipping duplicate cleanup');
			return;
		}

		getDependencies().logVoice('Transport failure detected', { failure });

		const channelId = getDependencies().getChannelId();
		if (!getDependencies().isConnected() || channelId === undefined) {
			return;
		}
		const phase = getDependencies().getVoiceSessionState().phase;
		if (phase.phase !== 'connected' || phase.channelId !== channelId) return;

		const previousCircuitState = transportRecoveryCircuit;
		const circuitDecision = resolveTransportRecoveryCircuitDecision({
			state: previousCircuitState,
			channelId,
			generation: phase.generation,
			now: getDependencies().now(),
		});
		let accepted = false;
		const commitAcceptedTransition = (transition: TTransportRecoveryTransition) => {
			const dispatchOutcome = resolveTransportFailureDispatchOutcome({
				circuitDecision,
				transition,
				previousCircuitState,
			});
			transportRecoveryCircuit = dispatchOutcome.circuitState;
			if (dispatchOutcome.accepted) {
				hasHandledTransportFailure = true;
				accepted = true;
			}
		};

		if (circuitDecision.action === 'stop') {
			getDependencies().dispatchVoiceSessionWithResult(
				{
					type: 'TransportRecoveryExhausted',
					channelId,
					connectedGeneration: phase.generation,
				},
				commitAcceptedTransition,
			);
		} else {
			getDependencies().dispatchVoiceSessionWithResult(
				{
					type: 'TransportFailed',
					channelId,
					nonce: getDependencies().getReconnectNonce(),
					connectedGeneration: phase.generation,
				},
				commitAcceptedTransition,
			);
		}

		if (!accepted) return;

		if (circuitDecision.action === 'stop') {
			getDependencies().logVoice('Rapid voice transport recovery exhausted', {
				channelId,
				rapidFailureCount: circuitDecision.state.rapidFailureCount,
				failure,
			});
		}
	};

	const ensureVoiceDeviceLoaded = async (isCurrent: () => boolean = () => true) => {
		if (!active || !isCurrent()) throw new VoiceSessionExecutionSupersededError();
		if (currentDevice) {
			return currentDevice;
		}

		const currentRouterRtpCapabilities = routerCapabilities;

		if (!currentRouterRtpCapabilities) {
			throw new Error('Router RTP capabilities not available');
		}

		const device = await getDependencies().createDevice();
		if (!active || !isCurrent()) throw new VoiceSessionExecutionSupersededError();
		await device.load({
			routerRtpCapabilities: currentRouterRtpCapabilities,
		});
		if (!isCurrent()) {
			throw new VoiceSessionExecutionSupersededError();
		}

		currentDevice = device;
		sendCapabilities = device.rtpCapabilities;

		return device;
	};

	const rejoinVoiceSession = async (
		channelId: number,
		options: { isCurrent?: () => boolean; signal?: AbortSignal } = {},
	): Promise<TRecoveryJoinResult> => {
		return getDependencies().traceSentrySpan(
			{
				name: 'voice.rejoin_session',
				op: 'voice.recovery',
				attributes: {},
			},
			async () => {
				const throwIfSuperseded = (): void => {
					if (!active || (options.isCurrent && !options.isCurrent())) throw new VoiceSessionExecutionSupersededError();
				};
				throwIfSuperseded();
				const currentOwnVoiceState = getDependencies().getOwnVoiceState();
				const {
					routerRtpCapabilities: nextRouterRtpCapabilities,
					producerTransportParams,
					consumerTransportParams,
					existingProducers,
					channelUsers,
				} = await getDependencies().requestVoiceRestoreOrJoin({
					channelId,
					micMuted: currentOwnVoiceState.micMuted,
					soundMuted: currentOwnVoiceState.soundMuted,
					reconnectAttemptId: getDependencies().createReconnectAttemptId(),
					signal: options.signal,
				});

				throwIfSuperseded();
				const device = await getDependencies().createDevice();
				throwIfSuperseded();
				await device.load({
					routerRtpCapabilities: nextRouterRtpCapabilities,
				});
				if (options.isCurrent && !options.isCurrent()) {
					throw new VoiceSessionExecutionSupersededError();
				}

				return {
					device,
					routerRtpCapabilities: nextRouterRtpCapabilities,
					channelUsers,
					existingProducers,
					producerTransportParams,
					consumerTransportParams,
				};
			},
		);
	};

	const cleanup = (opts?: {
		preserveLocalMedia?: boolean;
		preserveRemoteMediaIntent?: boolean;
		preserveSessionExecution?: boolean;
	}) => {
		getDependencies().logVoice('Running voice provider cleanup', {
			preserveLocalMedia: opts?.preserveLocalMedia ?? false,
		});
		if (!opts?.preserveSessionExecution) {
			invalidateVoiceSessionExecution(executionOwnership);
		}

		// When preserving local media (WS-reconnect restore), leave the desktop
		// app-audio pipeline running so a live screen-share audio track survives
		// to be republished; tearing it down would end the track.
		if (opts?.preserveLocalMedia) {
			getDependencies().shareAudio.detachProducer();
		}
		void getDependencies().microphone.cleanup();
		getDependencies().stopMonitoring();
		getDependencies().resetStats();
		getDependencies().clearActivity();
		if (opts?.preserveLocalMedia) getDependencies().webcam.detachProducer();
		else getDependencies().webcam.stop();
		if (opts?.preserveLocalMedia) getDependencies().screenShare.detachProducer();
		else getDependencies().screenShare.stop();
		getDependencies().clearRemoteUserStreams();
		getDependencies().clearExternalStreams();
		getDependencies().cleanupTransports({ preserveRemoteMediaIntent: opts?.preserveRemoteMediaIntent === true });
		getDependencies().clearMediaElementRefs();
		currentDevice = undefined;
		routerCapabilities = null;
		sendCapabilities = null;
		getDependencies().publishRtpCapabilities(null);
	};

	// Builds republish tasks for any live local webcam + screen-share (video and
	// audio) tracks onto the current producer transport. Shared by both recovery
	// paths, in-session transport recovery and WS-reconnect restore, so a live
	// screen share survives either. The mic is handled separately by each caller
	// because its re-acquire/republish semantics differ.

	const buildLocalMediaRepublishPlan = (isCurrent?: () => boolean): TLocalMediaRepublishPlan => {
		const tasks: Promise<void>[] = [];
		const state: TRepublishedLocalMediaState = {};

		const republishWebcam = getDependencies().webcam.republish(isCurrent);
		if (republishWebcam) {
			state.webcamEnabled = true;
			tasks.push(republishWebcam);
		}

		const republishScreen = getDependencies().screenShare.republish(isCurrent);
		if (republishScreen) {
			state.sharingScreen = true;
			tasks.push(republishScreen);
		}

		const republishAudio = getDependencies().shareAudio.republish(isCurrent);
		if (republishAudio) tasks.push(republishAudio);

		return { tasks, state };
	};

	const syncRepublishedLocalMediaState = async (
		state: TRepublishedLocalMediaState,
		options: { isCurrent?: () => boolean; signal?: AbortSignal } = {},
	) => {
		if (state.webcamEnabled !== true && state.sharingScreen !== true) {
			return;
		}
		if (options.isCurrent && !options.isCurrent()) {
			throw new VoiceSessionExecutionSupersededError();
		}

		await getDependencies().sendOwnVoiceStateUpdate(state, { signal: options.signal });
		if (options.isCurrent && !options.isCurrent()) {
			throw new VoiceSessionExecutionSupersededError();
		}
		getDependencies().updateOwnVoiceState(state);
	};

	const initialize = async (
		incomingRouterRtpCapabilities: RtpCapabilities,
		channelId: number,
		opts?: TVoiceSessionRuntimeInitOptions,
		executionLease?: () => boolean,
	) => {
		if (!active || (opts?.isCurrentRecovery && !opts.isCurrentRecovery()))
			throw new VoiceSessionExecutionSupersededError();
		const microphoneLifecycleLease = getDependencies().microphone.createLifecycleLease();
		const ownsSessionExecution = executionLease ?? claimVoiceSessionExecution(executionOwnership);
		let attemptOpen = true;
		const isOwnerCurrent = (): boolean =>
			active &&
			microphoneLifecycleLease.isCurrent() &&
			ownsSessionExecution() &&
			(opts?.isCurrentRecovery === undefined || opts.isCurrentRecovery());
		const isCurrent = (): boolean => attemptOpen && isOwnerCurrent();

		return getDependencies().traceSentrySpan(
			{
				name: 'voice.init',
				op: 'voice.join',
				attributes: {
					'voice.prefetched_transports': opts?.producerTransportParams !== undefined,
					'voice.has_existing_producers': opts?.existingProducers !== undefined,
					'voice.preserve_local_media': opts?.preserveLocalMedia === true,
				},
			},
			async () => {
				const throwIfRecoverySuperseded = (): void => {
					if (!isCurrent()) {
						throw new VoiceSessionExecutionSupersededError();
					}
				};

				getDependencies().logVoice('Initializing voice provider', {
					incomingRouterRtpCapabilities,
					channelId,
					prefetched: !!opts?.producerTransportParams,
					preserveLocalMedia: opts?.preserveLocalMedia ?? false,
				});

				let republishedLocalMediaState: TRepublishedLocalMediaState = {};

				throwIfRecoverySuperseded();
				cleanup({
					preserveLocalMedia: opts?.preserveLocalMedia,
					preserveRemoteMediaIntent: opts?.restoreWatchSnapshot !== undefined,
					preserveSessionExecution: true,
				});
				throwIfRecoverySuperseded();
				if (opts?.restoreWatchSnapshot !== undefined) {
					getDependencies().rehydrateWatchIntentOnly(opts.restoreWatchSnapshot);
				}
				let micPrepPromise: Promise<TMicrophonePreparedPipeline | undefined> | undefined;
				const dispatchJoinLifecycle = opts?.preserveLocalMedia !== true && opts?.restoreWatchSnapshot === undefined;

				try {
					if (dispatchJoinLifecycle) {
						getDependencies().dispatchVoiceSession({ type: 'JoinRequested', channelId });
					}

					throwIfRecoverySuperseded();
					routerCapabilities = incomingRouterRtpCapabilities;

					const device = await getDependencies().createDevice();
					throwIfRecoverySuperseded();

					if (!getDependencies().getOwnVoiceState().micMuted) {
						// Start mic acquisition + WASM pipeline immediately — these have no
						// dependency on the mediasoup device or transports and are the slowest
						// part of startMicStream. Running them concurrently with device.load()
						// and transport creation saves ~200-300ms on join.
						micPrepPromise = getDependencies()
							.microphone.prepare(isCurrent)
							.catch((error) => {
								// microphone.prepare cleans up after its own failures, and a
								// superseded build must not touch the successor's pipeline —
								// so no shared teardown here.
								getDependencies().logVoice('Error preparing microphone pipeline', { error });
								return undefined;
							});
					}

					await device.load({
						routerRtpCapabilities: incomingRouterRtpCapabilities,
					});
					throwIfRecoverySuperseded();
					currentDevice = device;
					sendCapabilities = device.rtpCapabilities;

					await Promise.all([
						getDependencies().createProducerTransport(device, opts?.producerTransportParams, isCurrent),
						getDependencies().createConsumerTransport(device, opts?.consumerTransportParams, isCurrent),
					]);
					throwIfRecoverySuperseded();
					getDependencies().publishRtpCapabilities(device.rtpCapabilities);

					const [, micPrepResult] = await Promise.all([
						getDependencies().consumeExistingProducers(device.rtpCapabilities, undefined, opts?.existingProducers),
						micPrepPromise,
					]);
					throwIfRecoverySuperseded();

					// Mic failures are non-fatal — voice join continues without a mic.
					if (micPrepResult) {
						try {
							await getDependencies().microphone.publish(micPrepResult, isCurrent);
						} catch (error) {
							getDependencies().logVoice('Error attaching microphone to transport', { error });

							// Tear down only while this build's pipeline is still the
							// installed one — a detached attempt failing late must not
							// destroy the successor's mic.
							if (getDependencies().microphone.owns(micPrepResult)) {
								await getDependencies().microphone.cleanup();
							}
						}
					}
					throwIfRecoverySuperseded();

					// Republish any preserved webcam/screen-share tracks (WS reconnect).
					// On a fresh join there are no live local tracks, so this is a no-op.
					if (opts?.preserveLocalMedia) {
						const republishPlan = buildLocalMediaRepublishPlan(isCurrent);

						if (republishPlan.tasks.length > 0) {
							getDependencies().logVoice('Republishing preserved local media after reconnect restore', {
								taskCount: republishPlan.tasks.length,
							});
							await Promise.all(republishPlan.tasks);
							republishedLocalMediaState = republishPlan.state;
						}

						throwIfRecoverySuperseded();
						if (getDependencies().shareAudio.hasDesktopIntent()) {
							void getDependencies()
								.shareAudio.recover()
								.catch((error) => {
									getDependencies().logVoice('Error recovering desktop app audio after reconnect restore', { error });
								});
						}
					}
					throwIfRecoverySuperseded();

					throwIfRecoverySuperseded();
					getDependencies().startMonitoring(
						getDependencies().getProducerTransport(),
						getDependencies().getConsumerTransport(),
					);
					if (dispatchJoinLifecycle) {
						getDependencies().dispatchVoiceSession({ type: 'JoinSucceeded', channelId });
						hasHandledTransportFailure = false;
					}

					return { republishedLocalMediaState };
				} catch (error) {
					// Revoke attempt currency before awaiting microphone preparation:
					// the other half of a failed transport pair may still finish.
					attemptOpen = false;
					if (isOwnerCurrent()) {
						getDependencies().webcam.detachProducer();
						getDependencies().screenShare.detachProducer();
						getDependencies().shareAudio.detachProducer();
						getDependencies().cleanupTransports({
							preserveRemoteMediaIntent: opts?.restoreWatchSnapshot !== undefined,
						});
						currentDevice = undefined;
						routerCapabilities = null;
						sendCapabilities = null;
						getDependencies().publishRtpCapabilities(null);
					}
					getDependencies().logVoice('Error initializing voice provider', { error });

					const preparedMic = await micPrepPromise;

					// Tear the mic pipeline down only while this init's build still
					// owns the shared refs. A detached recovery attempt (the reconnect
					// runner drains a cancelled attempt for a bounded window, then
					// detaches it) may settle this catch after its successor installed
					// a new pipeline — destroying it here would kill the live mic.
					// When the prep itself failed, it already cleaned up after itself.
					if (preparedMic && getDependencies().microphone.owns(preparedMic)) {
						await getDependencies().microphone.cleanup();
					}

					// Lifecycle state belongs to the current attempt; a superseded
					// recovery attempt must not fail its successor's join.
					if (isOwnerCurrent()) {
						if (dispatchJoinLifecycle) {
							getDependencies().dispatchVoiceSession({ type: 'JoinFailed', reason: 'join-failed', channelId });
						}
					}

					throw error;
				}
			},
		);
	};

	const init = (capabilities: RtpCapabilities, channelId: number, options?: TVoiceSessionRuntimeInitOptions) =>
		initialize(capabilities, channelId, options);

	const requestRecoveryFailureLeave = async (): Promise<void> => {
		// Offline terminal cleanup deliberately leaves the server seat to
		// disconnect grace; only a failed request on a live socket is reportable.
		if (!getDependencies().getServerState().connected) {
			return;
		}

		const didLeave = await getDependencies().leaveVoiceSessionAfterRecoveryFailure();
		if (!didLeave && getDependencies().getServerState().connected) {
			throw new Error('Failed to send voice.leave after voice recovery failure');
		}
	};

	const leaveAfterFailedTransportRecovery = async (channelId?: number): Promise<void> => {
		if (!active) return;
		const leaveRequest = channelId === undefined ? undefined : requestRecoveryFailureLeave();

		if (getDependencies().getChannelId() !== undefined) {
			getDependencies().getServerState().setCurrentVoiceChannelId(undefined);
			getDependencies().getServerState().updateOwnVoiceState({
				webcamEnabled: false,
				sharingScreen: false,
			});
			getDependencies().getServerState().setPinnedCard(undefined);
			getDependencies().notifyConnectionLost();
		}

		terminalCleanup();
		hasHandledTransportFailure = false;

		await leaveRequest;
	};

	const rebuildTransports = async (
		command: Extract<TVoiceSessionCommand, { type: 'RebuildTransports' }>,
		context: TVoiceSessionRebuildContext,
	): Promise<void> => {
		if (!active || !context.isCurrent()) throw new VoiceSessionExecutionSupersededError();
		const ownsSessionExecution = claimVoiceSessionExecution(executionOwnership);
		let attemptOpen = true;
		let transportsTouched = false;
		const isOwnerCurrent = (): boolean => active && ownsSessionExecution() && context.isCurrent();
		const isCurrentAttempt = (): boolean => attemptOpen && isOwnerCurrent() && getDependencies().isConnected();
		const restartIfNonceChanged = (): boolean => {
			if (!isCurrentAttempt()) throw new VoiceSessionExecutionSupersededError();
			return context.restartIfNonceChanged(getDependencies().getReconnectNonce());
		};

		return getDependencies().traceSentrySpan(
			{
				name: 'voice.transport_recovery',
				op: 'voice.recovery',
				attributes: {},
			},
			async () => {
				try {
					if (!isOwnerCurrent()) {
						throw new VoiceSessionExecutionSupersededError();
					}

					if (!getDependencies().isConnected()) {
						throw new Error('Voice transport recovery skipped: server connection unavailable');
					}

					if (getDependencies().getChannelId() === undefined) {
						throw new Error('Voice transport recovery skipped: user is no longer in voice');
					}

					if (!routerCapabilities) {
						throw new Error('Voice transport recovery skipped: router RTP capabilities unavailable');
					}

					transportsTouched = true;
					getDependencies().logVoice('Attempting in-session voice transport recovery', {
						attempt: command.attempt + 1,
						channelId: command.channelId,
					});

					getDependencies().stopMonitoring();
					getDependencies().resetStats();
					getDependencies().clearRemoteUserStreams();
					getDependencies().clearExternalStreams();
					getDependencies().publishRtpCapabilities(null);
					getDependencies().cleanupTransports({ preserveRemoteMediaIntent: true });
					getDependencies().rehydrateWatchIntentOnly(command.snapshot);

					let device = await getDependencies().withRecoveryTimeout(ensureVoiceDeviceLoaded(isCurrentAttempt));
					if (restartIfNonceChanged()) return;

					let currentRtpCapabilities = device.rtpCapabilities;
					let recoveryJoinResult: TRecoveryJoinResult | undefined;

					try {
						await getDependencies().withRecoveryTimeout(
							Promise.all([
								getDependencies().createProducerTransport(device, undefined, isCurrentAttempt),
								getDependencies().createConsumerTransport(device, undefined, isCurrentAttempt),
							]),
						);
					} catch (error) {
						if (!isCurrentAttempt()) throw new VoiceSessionExecutionSupersededError();
						const recoveryChannelId = getDependencies().getChannelId();

						if (getDependencies().getErrorCode(error) !== 'BAD_REQUEST' || recoveryChannelId === undefined) {
							throw error;
						}

						getDependencies().logVoice('Voice session missing during transport recovery, attempting fresh voice join', {
							channelId: recoveryChannelId,
							error,
						});

						recoveryJoinResult = await getDependencies().withRecoveryTimeout(
							rejoinVoiceSession(recoveryChannelId, {
								isCurrent: isCurrentAttempt,
								signal: context.signal,
							}),
						);
						if (restartIfNonceChanged()) return;

						device = recoveryJoinResult.device;
						currentRtpCapabilities = device.rtpCapabilities;
						currentDevice = device;
						routerCapabilities = recoveryJoinResult.routerRtpCapabilities;
						sendCapabilities = device.rtpCapabilities;
						const store = getDependencies().getServerState();
						store.setCurrentVoiceChannelId(recoveryChannelId);
						store.reconcileVoiceChannelUsers({
							channelId: recoveryChannelId,
							users: recoveryJoinResult.channelUsers,
						});

						await getDependencies().withRecoveryTimeout(
							Promise.all([
								getDependencies().createProducerTransport(
									device,
									recoveryJoinResult.producerTransportParams,
									isCurrentAttempt,
								),
								getDependencies().createConsumerTransport(
									device,
									recoveryJoinResult.consumerTransportParams,
									isCurrentAttempt,
								),
							]),
						);
					}

					if (restartIfNonceChanged()) return;

					sendCapabilities = currentRtpCapabilities;
					getDependencies().publishRtpCapabilities(currentRtpCapabilities);

					const republishTasks: Promise<void>[] = [];

					const currentAudioStream = getDependencies().getLocalAudioStream();
					const currentAudioTrack = currentAudioStream?.getAudioTracks()[0];
					republishTasks.push(
						recoverTransportMicrophone(
							{
								recoveryJoined: recoveryJoinResult !== undefined,
								micMuted: getDependencies().getOwnVoiceState().micMuted,
								canSpeak: getDependencies().canSpeak(),
								hasCurrentStream: currentAudioStream !== undefined,
								currentTrackLive: currentAudioTrack?.readyState === 'live',
							},
							{
								start: () => getDependencies().microphone.start(isCurrentAttempt),
								publishCurrent: () => getDependencies().microphone.publish('current', isCurrentAttempt),
								onStartFailed: (error) => {
									getDependencies().logVoice('Microphone restart failed during transport recovery; continuing muted', {
										error,
									});
									void getDependencies().commitTerminalMicMuted();
								},
							},
						).then((result) => {
							if (result === 'superseded') {
								throw new VoiceSessionExecutionSupersededError();
							}
						}),
					);

					const localMediaRepublishPlan = buildLocalMediaRepublishPlan(isCurrentAttempt);
					republishTasks.push(...localMediaRepublishPlan.tasks);

					await getDependencies().withRecoveryTimeout(
						Promise.all([
							getDependencies().consumeExistingProducers(
								currentRtpCapabilities,
								undefined,
								recoveryJoinResult?.existingProducers,
							),
							...republishTasks,
						]),
					);
					if (restartIfNonceChanged()) return;

					await getDependencies().withRecoveryTimeout(
						syncRepublishedLocalMediaState(localMediaRepublishPlan.state, {
							isCurrent: isCurrentAttempt,
							signal: context.signal,
						}),
					);
					if (restartIfNonceChanged()) return;

					if (recoveryJoinResult) {
						getDependencies().logVoice('Refreshing existing producers after voice session rejoin');
						await getDependencies().withRecoveryTimeout(
							getDependencies().consumeExistingProducers(currentRtpCapabilities),
						);
						if (restartIfNonceChanged()) return;

						await getDependencies().withRecoveryTimeout(getDependencies().waitForProducerRefresh());
						if (restartIfNonceChanged()) return;

						getDependencies().logVoice('Refreshing existing producers after delayed voice session rejoin sync');
						await getDependencies().withRecoveryTimeout(
							getDependencies().consumeExistingProducers(currentRtpCapabilities),
						);
					}

					if (restartIfNonceChanged()) return;

					if (recoveryJoinResult) {
						getDependencies().getServerState().bumpVoiceSessionReconnectNonce();
					}

					getDependencies().startMonitoring(
						getDependencies().getProducerTransport(),
						getDependencies().getConsumerTransport(),
					);
					getDependencies().logVoice('Voice transport recovery completed successfully');
				} catch (error) {
					attemptOpen = false;
					if (isOwnerCurrent() && transportsTouched) {
						getDependencies().webcam.detachProducer();
						getDependencies().screenShare.detachProducer();
						getDependencies().shareAudio.detachProducer();
						getDependencies().cleanupTransports({ preserveRemoteMediaIntent: true });
					}
					getDependencies().logVoice('Voice transport recovery attempt failed', {
						attempt: command.attempt + 1,
						error,
					});
					throw error;
				}
			},
		);
	};

	const restoreVoiceSession = async (
		command: Extract<TVoiceSessionCommand, { type: 'RestoreVoiceSession' }>,
		context: TVoiceSessionRestoreContext,
	): Promise<{ serverSessionEstablished: boolean }> => {
		if (!active || !context.isCurrent()) throw new VoiceSessionExecutionSupersededError();
		if (!getDependencies().isConnected()) throw new Error('Voice restore skipped: server connection unavailable');
		const ownsSessionExecution = claimVoiceSessionExecution(executionOwnership);
		let attemptOpen = true;
		const isCurrent = (): boolean =>
			attemptOpen && active && ownsSessionExecution() && context.isCurrent() && getDependencies().isConnected();
		const reconnectAttemptId = getDependencies().createReconnectAttemptId();
		const attemptNumber = command.attempt + 1;

		getDependencies().logDebug('Voice reconnect attempt start', {
			attempt: attemptNumber,
			channelId: command.pending.channelId,
			reconnectAttemptId,
		});

		try {
			const bootstrap = await context.withTimeout(
				getDependencies().requestVoiceRestoreOrJoin({
					channelId: command.pending.channelId,
					micMuted: command.pending.micMuted,
					soundMuted: command.pending.soundMuted,
					reconnectAttemptId,
					signal: context.signal,
				}),
			);
			context.markServerSessionEstablished();
			if (!isCurrent()) {
				throw new VoiceSessionExecutionSupersededError();
			}

			const initResult = await context.withTimeout(
				initialize(
					bootstrap.routerRtpCapabilities,
					command.pending.channelId,
					{
						producerTransportParams: bootstrap.producerTransportParams,
						consumerTransportParams: bootstrap.consumerTransportParams,
						existingProducers: bootstrap.existingProducers,
						preserveLocalMedia: true,
						restoreWatchSnapshot: command.snapshot,
						isCurrentRecovery: isCurrent,
					},
					ownsSessionExecution,
				),
			);
			if (!isCurrent()) {
				throw new VoiceSessionExecutionSupersededError();
			}

			const serverStore = getDependencies().getServerState();
			serverStore.setCurrentVoiceChannelId(command.pending.channelId);
			if (!isCurrent()) {
				throw new VoiceSessionExecutionSupersededError();
			}
			serverStore.reconcileVoiceChannelUsers({
				channelId: command.pending.channelId,
				users: bootstrap.channelUsers,
			});
			if (!isCurrent()) {
				throw new VoiceSessionExecutionSupersededError();
			}
			serverStore.bumpVoiceSessionReconnectNonce();

			await context.withTimeout(
				syncRepublishedLocalMediaState(initResult.republishedLocalMediaState, {
					isCurrent,
					signal: context.signal,
				}),
			);
			if (!isCurrent()) {
				throw new VoiceSessionExecutionSupersededError();
			}

			return { serverSessionEstablished: true };
		} catch (error) {
			attemptOpen = false;
			getDependencies().logDebug('Voice reconnect restore attempt failed', {
				attempt: attemptNumber,
				error,
			});
			throw error;
		}
	};

	const clearFailedVoiceSession = async (
		command: Extract<TVoiceSessionCommand, { type: 'ClearFailedSession' }>,
	): Promise<void> => {
		if (!active) return;
		// restoreOrJoin already bound a server-side session this cycle; without an
		// explicit leave the runtime would keep us resident in the channel even
		// though the client is giving up.
		const leaveRequest = command.leaveServerSession ? requestRecoveryFailureLeave() : undefined;

		getDependencies().clearOwnVoiceSessionAfterReconnectFailure(command.reason);
		terminalCleanup();

		await leaveRequest;
	};
	const terminalCleanup = (): void => cleanup();
	const recoveryCleanup = (): void => cleanup({ preserveLocalMedia: true, preserveRemoteMediaIntent: true });
	const onRecoverySucceeded = (
		transition: Extract<TTransportRecoveryTransition, { type: 'rebuild-succeeded' | 'reconnect-succeeded' }>,
	): void => {
		transportRecoveryCircuit = recordTransportRecoverySucceeded({ state: transportRecoveryCircuit, transition });
		hasHandledTransportFailure = false;
	};
	const syncChannel = (): void => {
		if (getDependencies().getChannelId() === undefined) transportRecoveryCircuit = undefined;
	};
	return {
		activate,
		deactivate,
		init,
		rebuildTransports,
		restoreVoiceSession,
		terminalCleanup,
		recoveryCleanup,
		onTransportFailure,
		onRecoverySucceeded,
		leaveVoiceSession: leaveAfterFailedTransportRecovery,
		clearFailedSession: clearFailedVoiceSession,
		captureRecoverySnapshot: () => getDependencies().captureWatchedRemoteStreams(),
		restoreWatchIntent: (snapshot: TWatchedRemoteStreamsSnapshot) => {
			if (active && getDependencies().isConnected()) getDependencies().rehydrateWatchIntentOnly(snapshot);
		},
		recoverDesktopAppAudio: async () => {
			if (!active || !getDependencies().isConnected()) return;
			await getDependencies().shareAudio.recover();
		},
		getRtpCapabilities: () => sendCapabilities,
		syncChannel,
	};
};

const mountVoiceSessionRuntime = (runtime: ReturnType<typeof createVoiceSessionRuntime>): (() => void) => {
	runtime.activate();
	let mounted = true;
	return () => {
		if (!mounted) return;
		mounted = false;
		runtime.deactivate();
	};
};

export { createVoiceSessionRuntime, mountVoiceSessionRuntime, type TVoiceSessionRuntimeDependencies };
