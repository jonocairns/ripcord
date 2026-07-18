import { resolveRawMicLossAction, type TRawMicLossReason } from './raw-mic-loss';

type TMicrophoneProcessingPipeline = {
	stream: MediaStream;
	track: MediaStreamTrack;
	setInputMuted: (muted: boolean) => void;
	destroy: () => Promise<void>;
};

type TMicrophoneGainPipeline = {
	stream: MediaStream;
	track: MediaStreamTrack;
	destroy: () => Promise<void>;
};

type TMicrophonePreparedPipeline = {
	readonly outboundStream: MediaStream;
	readonly outboundAudioTrack: MediaStreamTrack;
};

type TMicrophoneActivityMode = 'monitor' | 'inactive' | 'unavailable';

type TMicrophoneRecoveryReason = TRawMicLossReason | 'default-input-move';

type TMicrophoneStartOutcome = { status: 'started' } | { status: 'failed'; error: unknown } | { status: 'superseded' };

type TMicrophoneRecoveryOutcome = TMicrophoneStartOutcome | { status: 'exhausted' };

type TMicrophoneProducerPublicationLease<TProducer extends object> = {
	publish: (track: MediaStreamTrack) => Promise<TProducer>;
	isCurrent: () => boolean;
};

type TMicrophoneLocalPublication = {
	stream: MediaStream;
	remove: () => void;
};

type TMicrophonePipelineControllerPorts<
	TProducer extends object,
	TProcessingPipeline extends TMicrophoneProcessingPipeline,
	TGainPipeline extends TMicrophoneGainPipeline,
> = {
	getUserMedia: (constraints: MediaTrackConstraints) => Promise<MediaStream>;
	createProcessingPipeline: (input: {
		inputTrack: MediaStreamTrack;
		enabled: boolean;
		onRuntimeError: (error: Error) => void;
	}) => Promise<TProcessingPipeline | undefined>;
	createGainPipeline: (inputStream: MediaStream, volume: number) => Promise<TGainPipeline | undefined>;
	setGainVolume: (pipeline: TGainPipeline, volume: number) => void;
	createProducerPublicationLease: () => TMicrophoneProducerPublicationLease<TProducer> | undefined;
	publishLocalStream: (stream: MediaStream) => TMicrophoneLocalPublication;
	getProducerId: (producer: TProducer) => string;
	isProducerClosed: (producer: TProducer) => boolean;
	closeProducer: (producer: TProducer) => void;
	observeProducerClosed: (producer: TProducer, onClosed: () => void) => void;
	closeProducerOnServer: (producerId: string) => void;
	getActivityMode: () => TMicrophoneActivityMode;
	startActivityMonitor: (producer: TProducer, onUpdate: (isSpeaking: boolean | undefined) => void) => () => void;
	onActivityUpdate: (isSpeaking: boolean | undefined, producerId: string | undefined) => void;
	isInVoiceChannel: () => boolean;
	isMicMuted: () => boolean;
	reacquire: (reason: TMicrophoneRecoveryReason) => Promise<TMicrophoneStartOutcome>;
	onRecoveryExhausted: (reason: TMicrophoneRecoveryReason) => void;
	onProcessingRuntimeError: (error: Error) => void;
	setTimeout: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
	log?: (message: string, context?: Record<string, unknown>) => void;
	rawMuteSettleMs?: number;
	rawRecoveryMaxAttempts?: number;
	rawRecoveryStabilityMs?: number;
};

type TPrepareMicrophonePipelineInput = {
	constraints: MediaTrackConstraints;
	processingEnabled: boolean;
	gainVolume: number;
	selectedMicrophoneId?: string;
	isCurrent?: () => boolean;
};

type TPublishMicrophonePipelineInput = {
	source: TMicrophonePreparedPipeline | 'current';
	isCurrent?: () => boolean;
};

type TMicrophonePipelineLifecycleLease = {
	isCurrent: () => boolean;
};

type TMicrophonePipelineLifecycle = {
	activate: () => void;
	deactivate: () => Promise<void>;
};

class MicPipelineSupersededError extends Error {
	constructor() {
		super('Microphone pipeline superseded by a newer build');
		this.name = 'MicPipelineSupersededError';
	}
}

const DEFAULT_RAW_MUTE_SETTLE_MS = 400;
const DEFAULT_RAW_RECOVERY_MAX_ATTEMPTS = 3;
const DEFAULT_RAW_RECOVERY_STABILITY_MS = 10_000;

const createMicrophonePipelineController = <
	TProducer extends object,
	TProcessingPipeline extends TMicrophoneProcessingPipeline,
	TGainPipeline extends TMicrophoneGainPipeline,
>(
	ports: TMicrophonePipelineControllerPorts<TProducer, TProcessingPipeline, TGainPipeline>,
) => {
	let epoch = 0;
	// The controller is created during render but may own media only while its
	// provider lifecycle is committed. Strict Mode can deactivate and reactivate
	// the same retained instance, so this fence must be reversible.
	let lifecycleGeneration = 0;
	let active = false;
	let rawMicStream: MediaStream | undefined;
	let removeRawLossListeners: (() => void) | undefined;
	let processingPipeline: TProcessingPipeline | undefined;
	let gainPipeline: TGainPipeline | undefined;
	let preparedPipeline: TMicrophonePreparedPipeline | undefined;
	let localPublication: TMicrophoneLocalPublication | undefined;
	let localProducer: TProducer | undefined;
	let activityCleanup: (() => void) | undefined;
	let activityProducer: TProducer | undefined;
	let rawRecoveryAttempts = 0;
	let recoveryOperation: Promise<TMicrophoneRecoveryOutcome> | undefined;
	let rawRecoveryStabilityTimer: ReturnType<typeof setTimeout> | undefined;
	const handledProducerClosures = new WeakSet<TProducer>();

	const log = (message: string, context?: Record<string, unknown>): void => {
		ports.log?.(message, context);
	};

	const ownsEpoch = (ownedEpoch: number): boolean => active && epoch === ownedEpoch;

	const owns = (prepared: TMicrophonePreparedPipeline): boolean => active && preparedPipeline === prepared;

	const clearRawRecoveryStabilityTimer = (): void => {
		if (rawRecoveryStabilityTimer === undefined) {
			return;
		}

		ports.clearTimeout(rawRecoveryStabilityTimer);
		rawRecoveryStabilityTimer = undefined;
	};

	const resetRawRecoveryBudget = (): void => {
		clearRawRecoveryStabilityTimer();
		rawRecoveryAttempts = 0;
	};

	const recover = (reason: TMicrophoneRecoveryReason): Promise<TMicrophoneRecoveryOutcome> => {
		if (recoveryOperation) {
			return recoveryOperation;
		}

		const operation = (async (): Promise<TMicrophoneRecoveryOutcome> => {
			const maxAttempts = ports.rawRecoveryMaxAttempts ?? DEFAULT_RAW_RECOVERY_MAX_ATTEMPTS;

			while (active && ports.isInVoiceChannel() && !ports.isMicMuted()) {
				if (rawRecoveryAttempts >= maxAttempts) {
					log('Microphone recovery exhausted, stopping microphone', {
						reason,
						attempts: rawRecoveryAttempts,
					});
					const cleanupPromise = cleanup();
					// cleanup's synchronous prologue stops and detaches every local
					// resource. Commit terminal intent immediately afterward so a user
					// operation that starts while graph destruction drains is newer.
					ports.onRecoveryExhausted(reason);
					await cleanupPromise;
					return { status: 'exhausted' };
				}

				rawRecoveryAttempts += 1;
				log('Microphone capture interrupted, re-acquiring', { reason, attempt: rawRecoveryAttempts });
				let outcome: TMicrophoneStartOutcome;
				try {
					outcome = await ports.reacquire(reason);
				} catch (error) {
					outcome = { status: 'failed', error };
				}

				if (outcome.status === 'superseded') {
					// The recovery owner did not accept this attempt. Preserve the
					// budget for the operation that superseded it.
					rawRecoveryAttempts -= 1;
					return outcome;
				}

				if (outcome.status === 'started') {
					return outcome;
				}

				log('Microphone re-acquisition failed', {
					reason,
					attempt: rawRecoveryAttempts,
					error: outcome.error,
				});
			}

			return { status: 'superseded' };
		})();

		recoveryOperation = operation;
		void operation.finally(() => {
			if (recoveryOperation === operation) {
				recoveryOperation = undefined;
			}
		});

		return operation;
	};

	const activate = (): void => {
		if (active) {
			return;
		}

		// Activation is an ownership boundary even when the previous asynchronous
		// cleanup tail is still destroying resources captured by deactivation.
		active = true;
		lifecycleGeneration += 1;
		epoch += 1;
	};

	const createLifecycleLease = (): TMicrophonePipelineLifecycleLease => {
		const ownedGeneration = lifecycleGeneration;

		return {
			isCurrent: () => active && lifecycleGeneration === ownedGeneration,
		};
	};

	const stopActivity = (isSpeaking: boolean | undefined): void => {
		const producerId = localProducer === undefined ? undefined : ports.getProducerId(localProducer);
		const cleanup = activityCleanup;
		activityCleanup = undefined;
		activityProducer = undefined;
		cleanup?.();
		ports.onActivityUpdate(isSpeaking, producerId);
	};

	const syncActivity = (): void => {
		const producer = localProducer;
		const mode = ports.getActivityMode();

		if (!producer || ports.isProducerClosed(producer) || mode !== 'monitor') {
			stopActivity(mode === 'inactive' ? false : undefined);
			return;
		}

		if (activityCleanup && activityProducer === producer) {
			return;
		}

		stopActivity(undefined);
		activityProducer = producer;
		activityCleanup = ports.startActivityMonitor(producer, (isSpeaking) => {
			if (localProducer !== producer || activityProducer !== producer) {
				return;
			}

			ports.onActivityUpdate(isSpeaking, ports.getProducerId(producer));
		});
	};

	const handleProducerClosed = (producer: TProducer): void => {
		if (handledProducerClosures.has(producer)) {
			return;
		}

		handledProducerClosures.add(producer);
		const producerId = ports.getProducerId(producer);
		log('Audio producer closed', { producerId });

		if (localProducer === producer) {
			localProducer = undefined;
			stopActivity(false);
		}

		ports.closeProducerOnServer(producerId);
	};

	const observeProducer = (producer: TProducer): void => {
		ports.observeProducerClosed(producer, () => {
			handleProducerClosed(producer);
		});

		if (ports.isProducerClosed(producer)) {
			handleProducerClosed(producer);
		}
	};

	const closeOwnedProducer = (producer: TProducer): void => {
		if (!ports.isProducerClosed(producer)) {
			ports.closeProducer(producer);
		}

		if (!handledProducerClosures.has(producer)) {
			handleProducerClosed(producer);
		}
	};

	const cleanup = async (): Promise<void> => {
		epoch += 1;
		stopActivity(false);
		clearRawRecoveryStabilityTimer();

		// Snapshot and clear every shared resource synchronously. Once this block
		// completes, the async destruction tail touches captured resources only.
		const producer = localProducer;
		localProducer = undefined;
		const capturedGainPipeline = gainPipeline;
		gainPipeline = undefined;
		const capturedRawStream = rawMicStream;
		rawMicStream = undefined;
		const capturedProcessingPipeline = processingPipeline;
		processingPipeline = undefined;
		const capturedPreparedPipeline = preparedPipeline;
		preparedPipeline = undefined;
		const capturedLocalPublication = localPublication;
		localPublication = undefined;
		const capturedRemoveRawLossListeners = removeRawLossListeners;
		removeRawLossListeners = undefined;

		capturedRemoveRawLossListeners?.();

		if (capturedPreparedPipeline) {
			capturedPreparedPipeline.outboundAudioTrack.onended = null;
		}

		if (producer) {
			closeOwnedProducer(producer);
		}

		// Stop physical capture and the final outbound track before marking the
		// identity-scoped React publication inactive. Graph destruction can then
		// finish asynchronously without leaving the browser mic indicator active.
		capturedPreparedPipeline?.outboundAudioTrack.stop();
		capturedRawStream?.getTracks().forEach((track) => {
			track.stop();
		});
		capturedLocalPublication?.remove();

		if (capturedGainPipeline) {
			try {
				await capturedGainPipeline.destroy();
			} catch (error) {
				log('Failed to clean up microphone gain pipeline', { error });
			}
		}

		if (capturedProcessingPipeline) {
			try {
				await capturedProcessingPipeline.destroy();
			} catch (error) {
				log('Failed to clean up microphone processing pipeline', { error });
			}
		}
	};

	const attachRawLossListeners = (stream: MediaStream, rawTrack: MediaStreamTrack): (() => void) => {
		let muteSettleTimer: ReturnType<typeof setTimeout> | undefined;

		const clearMuteSettleTimer = (): void => {
			if (muteSettleTimer === undefined) {
				return;
			}

			ports.clearTimeout(muteSettleTimer);
			muteSettleTimer = undefined;
		};

		const evaluateRawMicLoss = (reason: TRawMicLossReason): void => {
			const action = resolveRawMicLossAction({
				reason,
				superseded: rawMicStream !== stream,
				inChannel: ports.isInVoiceChannel(),
				micMuted: ports.isMicMuted(),
				trackStillMuted: rawTrack.muted,
			});

			if (action === 'ignore') {
				return;
			}

			if (action === 'teardown-for-unmute') {
				log('Raw mic interrupted while muted, tearing down for next unmute', { reason });
				void cleanup();
				return;
			}

			void recover(reason);
		};

		const handleMute = (): void => {
			if (muteSettleTimer !== undefined) {
				return;
			}

			muteSettleTimer = ports.setTimeout(() => {
				muteSettleTimer = undefined;
				evaluateRawMicLoss('mute');
			}, ports.rawMuteSettleMs ?? DEFAULT_RAW_MUTE_SETTLE_MS);
		};
		const handleEnded = (): void => {
			clearMuteSettleTimer();
			evaluateRawMicLoss('ended');
		};

		rawTrack.addEventListener('mute', handleMute);
		rawTrack.addEventListener('unmute', clearMuteSettleTimer);
		rawTrack.addEventListener('ended', handleEnded);

		return () => {
			clearMuteSettleTimer();
			rawTrack.removeEventListener('mute', handleMute);
			rawTrack.removeEventListener('unmute', clearMuteSettleTimer);
			rawTrack.removeEventListener('ended', handleEnded);
		};
	};

	const prepare = async (input: TPrepareMicrophonePipelineInput): Promise<TMicrophonePreparedPipeline> => {
		const isCallerCurrent = (): boolean => input.isCurrent === undefined || input.isCurrent();

		// Reject stale callers before cleanup snapshots the currently published
		// pipeline. The controller may be active again after Strict Mode replay,
		// while a caller holding the previous lifecycle lease is still stale.
		if (!active || !isCallerCurrent()) {
			throw new MicPipelineSupersededError();
		}

		// Claim in the same synchronous tick as starting cleanup. The cleanup
		// prologue has already captured and cleared the previous resources, while
		// this increment makes build-start order authoritative.
		const cleanupPromise = cleanup();
		epoch += 1;
		const ownedEpoch = epoch;
		const ownsPreparation = (): boolean => ownsEpoch(ownedEpoch) && isCallerCurrent();

		await cleanupPromise;

		if (!ownsPreparation()) {
			throw new MicPipelineSupersededError();
		}

		let stream: MediaStream | undefined;

		try {
			stream = await ports.getUserMedia(input.constraints);

			if (!ownsPreparation()) {
				throw new MicPipelineSupersededError();
			}

			log('Microphone stream obtained', { stream });
			rawMicStream = stream;

			const rawAudioTrack = stream.getAudioTracks()[0];
			if (!rawAudioTrack) {
				throw new Error('Failed to obtain audio track from microphone');
			}

			const rawTrackSettings = rawAudioTrack.getSettings();
			log('Microphone capture device resolved', {
				selectedMicrophoneId: input.selectedMicrophoneId,
				trackLabel: rawAudioTrack.label,
				trackDeviceId: rawTrackSettings.deviceId,
				trackGroupId: rawTrackSettings.groupId,
			});

			removeRawLossListeners = attachRawLossListeners(stream, rawAudioTrack);

			let outboundStream = stream;
			let outboundAudioTrack = rawAudioTrack;

			try {
				let createdProcessingPipeline: TProcessingPipeline | undefined;
				createdProcessingPipeline = await ports.createProcessingPipeline({
					inputTrack: rawAudioTrack,
					enabled: input.processingEnabled,
					onRuntimeError: (error) => {
						if (createdProcessingPipeline && processingPipeline === createdProcessingPipeline) {
							ports.onProcessingRuntimeError(error);
						}
					},
				});

				if (!ownsPreparation()) {
					if (createdProcessingPipeline) {
						try {
							await createdProcessingPipeline.destroy();
						} catch (error) {
							log('Failed to dispose superseded microphone voice filter', { error });
						}
					}
					throw new MicPipelineSupersededError();
				}

				processingPipeline = createdProcessingPipeline;
				if (createdProcessingPipeline) {
					outboundStream = createdProcessingPipeline.stream;
					outboundAudioTrack = createdProcessingPipeline.track;
					log('Microphone voice filter enabled');
				}
			} catch (error) {
				if (error instanceof MicPipelineSupersededError) {
					throw error;
				}

				if (!ownsPreparation()) {
					throw new MicPipelineSupersededError();
				}

				processingPipeline = undefined;
				log('Failed to initialize microphone voice filter, using raw mic', { error });
			}

			let createdGainPipeline: TGainPipeline | undefined;
			try {
				createdGainPipeline = await ports.createGainPipeline(outboundStream, input.gainVolume);
			} catch (error) {
				if (!ownsPreparation()) {
					throw new MicPipelineSupersededError();
				}

				throw error;
			}

			if (!ownsPreparation()) {
				if (createdGainPipeline) {
					try {
						await createdGainPipeline.destroy();
					} catch (error) {
						log('Failed to dispose superseded microphone gain pipeline', { error });
					}
				}
				throw new MicPipelineSupersededError();
			}

			gainPipeline = createdGainPipeline;
			if (createdGainPipeline) {
				outboundStream = createdGainPipeline.stream;
				outboundAudioTrack = createdGainPipeline.track;
				log('Microphone gain pipeline enabled', { volume: input.gainVolume });
			}

			const prepared: TMicrophonePreparedPipeline = {
				outboundStream,
				outboundAudioTrack,
			};
			preparedPipeline = prepared;

			return prepared;
		} catch (error) {
			// The stream belongs to this attempt even when a successor owns the
			// controller epoch. Shared refs may be cleaned only while this attempt
			// still owns that epoch; otherwise successor cleanup already captured them.
			stream?.getTracks().forEach((track) => {
				track.stop();
			});
			if (ownsEpoch(ownedEpoch)) {
				await cleanup();
			}

			throw error;
		}
	};

	const resolvePublishSource = (source: TMicrophonePreparedPipeline | 'current'): TMicrophonePreparedPipeline => {
		const prepared = source === 'current' ? preparedPipeline : source;
		if (!prepared || !owns(prepared)) {
			throw new MicPipelineSupersededError();
		}

		return prepared;
	};

	const publish = async ({ source, isCurrent = () => true }: TPublishMicrophonePipelineInput): Promise<void> => {
		const prepared = resolvePublishSource(source);
		const publicationLease = ports.createProducerPublicationLease();
		if (!publicationLease?.isCurrent() || !isCurrent()) {
			throw new MicPipelineSupersededError();
		}

		if (!localPublication || localPublication.stream !== prepared.outboundStream) {
			localPublication?.remove();
			localPublication = ports.publishLocalStream(prepared.outboundStream);
		}

		const micMuted = ports.isMicMuted();
		prepared.outboundAudioTrack.enabled = !micMuted;
		processingPipeline?.setInputMuted(micMuted);
		log('Obtained audio track', { audioTrack: prepared.outboundAudioTrack });

		let producer: TProducer;
		try {
			producer = await publicationLease.publish(prepared.outboundAudioTrack);
		} catch (error) {
			if (!owns(prepared) || !publicationLease.isCurrent() || !isCurrent()) {
				throw new MicPipelineSupersededError();
			}

			throw error;
		}

		observeProducer(producer);

		if (!owns(prepared) || !publicationLease.isCurrent() || !isCurrent()) {
			closeOwnedProducer(producer);
			throw new MicPipelineSupersededError();
		}

		localProducer = producer;
		syncActivity();
		log('Microphone audio producer created', { producer });
		clearRawRecoveryStabilityTimer();
		rawRecoveryStabilityTimer = ports.setTimeout(() => {
			rawRecoveryStabilityTimer = undefined;
			rawRecoveryAttempts = 0;
		}, ports.rawRecoveryStabilityMs ?? DEFAULT_RAW_RECOVERY_STABILITY_MS);

		const publishedProducer = producer;
		prepared.outboundAudioTrack.onended = () => {
			if (!owns(prepared) || localProducer !== publishedProducer) {
				return;
			}

			// The raw track's device-loss listeners own passthrough capture loss.
			if (prepared.outboundStream === rawMicStream) {
				return;
			}

			log('Audio pipeline output track ended, cleaning up microphone');
			void cleanup();
		};
	};

	const setMuted = (muted: boolean): void => {
		if (!muted) {
			resetRawRecoveryBudget();
		}

		preparedPipeline?.outboundStream.getAudioTracks().forEach((track) => {
			track.enabled = !muted;
		});
		processingPipeline?.setInputMuted(muted);
	};

	const setGainVolume = (volume: number): void => {
		if (gainPipeline) {
			ports.setGainVolume(gainPipeline, volume);
		}
	};

	const deactivate = async (): Promise<void> => {
		if (!active) {
			return;
		}

		active = false;
		lifecycleGeneration += 1;
		resetRawRecoveryBudget();
		await cleanup();
	};

	return {
		activate,
		deactivate,
		createLifecycleLease,
		recover,
		prepare,
		publish,
		cleanup,
		owns,
		setMuted,
		setGainVolume,
		syncActivity,
		getRawTrack: (): MediaStreamTrack | undefined => rawMicStream?.getAudioTracks()[0],
		hasGainPipeline: (): boolean => gainPipeline !== undefined,
	};
};

type TMicrophonePipelineController<
	TProducer extends object,
	TProcessingPipeline extends TMicrophoneProcessingPipeline,
	TGainPipeline extends TMicrophoneGainPipeline,
> = ReturnType<typeof createMicrophonePipelineController<TProducer, TProcessingPipeline, TGainPipeline>>;

export type {
	TMicrophoneActivityMode,
	TMicrophoneGainPipeline,
	TMicrophonePipelineController,
	TMicrophonePipelineControllerPorts,
	TMicrophonePipelineLifecycle,
	TMicrophonePipelineLifecycleLease,
	TMicrophonePreparedPipeline,
	TMicrophoneProcessingPipeline,
	TMicrophoneProducerPublicationLease,
	TMicrophoneRecoveryOutcome,
	TMicrophoneRecoveryReason,
	TMicrophoneStartOutcome,
	TPrepareMicrophonePipelineInput,
	TPublishMicrophonePipelineInput,
};
export { createMicrophonePipelineController, MicPipelineSupersededError };
