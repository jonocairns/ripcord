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
	onRawLossRecover: (reason: TRawMicLossReason) => void;
	onProcessingRuntimeError: (error: Error) => void;
	setTimeout: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
	log?: (message: string, context?: Record<string, unknown>) => void;
	rawMuteSettleMs?: number;
};

type TPrepareMicrophonePipelineInput = {
	constraints: MediaTrackConstraints;
	processingEnabled: boolean;
	gainVolume: number;
	selectedMicrophoneId?: string;
};

type TPublishMicrophonePipelineInput = {
	source: TMicrophonePreparedPipeline | 'current';
	isCurrent?: () => boolean;
};

class MicPipelineSupersededError extends Error {
	constructor() {
		super('Microphone pipeline superseded by a newer build');
		this.name = 'MicPipelineSupersededError';
	}
}

const DEFAULT_RAW_MUTE_SETTLE_MS = 400;

const createMicrophonePipelineController = <
	TProducer extends object,
	TProcessingPipeline extends TMicrophoneProcessingPipeline,
	TGainPipeline extends TMicrophoneGainPipeline,
>(
	ports: TMicrophonePipelineControllerPorts<TProducer, TProcessingPipeline, TGainPipeline>,
) => {
	let epoch = 0;
	let disposed = false;
	let rawMicStream: MediaStream | undefined;
	let removeRawLossListeners: (() => void) | undefined;
	let processingPipeline: TProcessingPipeline | undefined;
	let gainPipeline: TGainPipeline | undefined;
	let preparedPipeline: TMicrophonePreparedPipeline | undefined;
	let localPublication: TMicrophoneLocalPublication | undefined;
	let localProducer: TProducer | undefined;
	let activityCleanup: (() => void) | undefined;
	let activityProducer: TProducer | undefined;
	const handledProducerClosures = new WeakSet<TProducer>();

	const log = (message: string, context?: Record<string, unknown>): void => {
		ports.log?.(message, context);
	};

	const ownsEpoch = (ownedEpoch: number): boolean => !disposed && epoch === ownedEpoch;

	const owns = (prepared: TMicrophonePreparedPipeline): boolean => !disposed && preparedPipeline === prepared;

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

		capturedLocalPublication?.remove();

		if (capturedGainPipeline) {
			try {
				await capturedGainPipeline.destroy();
			} catch (error) {
				log('Failed to clean up microphone gain pipeline', { error });
			}
		}

		capturedRawStream?.getTracks().forEach((track) => {
			track.stop();
		});

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

			log('Raw mic capture interrupted, re-acquiring', { reason });
			ports.onRawLossRecover(reason);
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
		if (disposed) {
			throw new MicPipelineSupersededError();
		}

		// Claim in the same synchronous tick as starting cleanup. The cleanup
		// prologue has already captured and cleared the previous resources, while
		// this increment makes build-start order authoritative.
		const cleanupPromise = cleanup();
		epoch += 1;
		const ownedEpoch = epoch;

		await cleanupPromise;

		if (!ownsEpoch(ownedEpoch)) {
			throw new MicPipelineSupersededError();
		}

		let stream: MediaStream | undefined;

		try {
			stream = await ports.getUserMedia(input.constraints);

			if (!ownsEpoch(ownedEpoch)) {
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

				if (!ownsEpoch(ownedEpoch)) {
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

				if (!ownsEpoch(ownedEpoch)) {
					throw new MicPipelineSupersededError();
				}

				processingPipeline = undefined;
				log('Failed to initialize microphone voice filter, using raw mic', { error });
			}

			let createdGainPipeline: TGainPipeline | undefined;
			try {
				createdGainPipeline = await ports.createGainPipeline(outboundStream, input.gainVolume);
			} catch (error) {
				if (!ownsEpoch(ownedEpoch)) {
					throw new MicPipelineSupersededError();
				}

				throw error;
			}

			if (!ownsEpoch(ownedEpoch)) {
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
			if (error instanceof MicPipelineSupersededError || !ownsEpoch(ownedEpoch)) {
				stream?.getTracks().forEach((track) => {
					track.stop();
				});
			} else {
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

		const producer = await publicationLease.publish(prepared.outboundAudioTrack);

		if (!publicationLease.isCurrent() || !isCurrent()) {
			ports.closeProducer(producer);
			throw new MicPipelineSupersededError();
		}

		observeProducer(producer);
		localProducer = producer;
		syncActivity();
		log('Microphone audio producer created', { producer });

		prepared.outboundAudioTrack.onended = () => {
			// The raw track's device-loss listeners own passthrough capture loss.
			if (prepared.outboundStream === rawMicStream) {
				return;
			}

			log('Audio pipeline output track ended, cleaning up microphone');
			void cleanup();
		};
	};

	const setMuted = (muted: boolean): void => {
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

	const dispose = async (): Promise<void> => {
		if (disposed) {
			return;
		}

		disposed = true;
		await cleanup();
	};

	return {
		prepare,
		publish,
		cleanup,
		owns,
		setMuted,
		setGainVolume,
		syncActivity,
		getRawTrack: (): MediaStreamTrack | undefined => rawMicStream?.getAudioTracks()[0],
		hasGainPipeline: (): boolean => gainPipeline !== undefined,
		dispose,
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
	TMicrophonePreparedPipeline,
	TMicrophoneProcessingPipeline,
	TMicrophoneProducerPublicationLease,
	TPrepareMicrophonePipelineInput,
	TPublishMicrophonePipelineInput,
};
export { createMicrophonePipelineController, MicPipelineSupersededError };
