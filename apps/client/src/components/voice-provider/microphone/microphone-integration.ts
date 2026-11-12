import { StreamKind, type TPublicChannel } from '@sharkord/shared';
import type { AppData, Producer, Transport } from 'mediasoup-client/types';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import type { TDeviceSettings } from '@/types';
import { getAudioOpusConfig } from '../audio-producer-config';
import {
	OWN_MIC_VOLUME_KEY,
	type TVolumeSettingsUpdatedDetail,
	VOLUME_SETTINGS_UPDATED_EVENT,
} from '../volume-control-storage';
import {
	resolveDefaultInputGroupId,
	resolveDefaultInputRecoveryDecision,
	type TDefaultInputMove,
} from './default-input-device';
import type { startLocalVoiceActivityMonitor } from './local-voice-activity';
import { type ActivityBroadcastState, resolveActivityBroadcast } from './local-voice-activity';
import type { createMicAudioProcessingPipeline, TMicAudioProcessingPipeline } from './mic-audio-processing';
import { resolveMicCaptureConfig } from './mic-capture-config';
import {
	clampVolumePercent,
	type createMicGainPipeline,
	shouldUseMicGainPipeline,
	type TMicGainPipeline,
} from './mic-gain-pipeline';
import {
	createMicrophonePipelineController,
	MicPipelineSupersededError,
	type TMicrophonePipelineController,
	type TMicrophonePreparedPipeline,
	type TMicrophoneRecoveryReason,
	type TMicrophoneStartOutcome,
} from './microphone-pipeline-controller';
import { mountMicrophonePipelineController } from './use-microphone-pipeline-controller-lifecycle';

// Debounce driver bursts and let Chromium repoint its synthetic default entry
// before retrying within the existing metadata polling window.
const DEFAULT_INPUT_DEVICE_CHANGE_DEBOUNCE_MS = 500;
const DEFAULT_INPUT_DEVICE_CHANGE_RETRY_INTERVAL_MS = 250;
const DEFAULT_INPUT_DEVICE_CHANGE_RETRY_WINDOW_MS = 1500;

type TMicrophoneIntegrationInputs = {
	devices: TDeviceSettings;
	currentVoiceChannelId: number | undefined;
	localAudioStream: MediaStream | undefined;
	isConnected: boolean;
	canSpeak: boolean;
	ownUserId: number | undefined;
};

type TMicrophoneIntegrationPorts = {
	getInputs: () => TMicrophoneIntegrationInputs;
	isMicMuted: () => boolean;
	canSpeak: (channel: number | undefined) => boolean;
	isTransmitGateOpen: () => boolean;
	beginOperation: () => number;
	isOperationCurrent: (token: number) => boolean;
	getProducerTransport: () => Transport<AppData> | undefined;
	getChannelSettings: () => Pick<TPublicChannel, 'voiceBitrate' | 'voiceDtx'> | undefined;
	getMediaDevices: () => MediaDevices | undefined;
	getVolumeEventTarget: () => Pick<Window, 'addEventListener' | 'removeEventListener'>;
	getStoredVolume: () => number;
	createProcessingPipeline: typeof createMicAudioProcessingPipeline;
	createGainPipeline: typeof createMicGainPipeline;
	publishLocalStream: (stream: MediaStream) => { stream: MediaStream; remove: () => void };
	closeProducerOnServer: (producerId: string) => void;
	startActivityMonitor: typeof startLocalVoiceActivityMonitor;
	setLocalActivity: (userId: number, isSpeaking: boolean | undefined) => void;
	broadcastActivity: (activity: { isSpeaking: boolean; seq: number; producerId: string }) => void;
	// Commits shared muted state through the provider's voice-state sequence.
	commitTerminalMicMuted: () => void;
	error: (message: string) => void;
	log: (message: string, context?: Record<string, unknown>) => void;
	now: () => number;
	setTimeout: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
};

const createMicrophoneIntegration = (ports: TMicrophoneIntegrationPorts) => {
	let sessionGeneration = 0;

	let activitySequence = 0;
	let activityBroadcastState: ActivityBroadcastState = { producerId: undefined, hasAnnouncedSpeaking: false };
	let cleanupSubscriptions: (() => void) | undefined;
	let cleanupDefaultInputListener: (() => void) | undefined;
	let defaultInputChannelId: number | undefined;
	let selectedMicrophoneId: string | undefined;

	const controller: TMicrophonePipelineController<
		Producer<AppData>,
		TMicAudioProcessingPipeline,
		TMicGainPipeline
	> = createMicrophonePipelineController({
		getUserMedia: (constraints) => {
			const mediaDevices = ports.getMediaDevices();
			if (!mediaDevices) throw new Error('Microphone capture unavailable');
			return mediaDevices.getUserMedia({ audio: constraints, video: false });
		},
		createProcessingPipeline: ({ inputTrack, enabled, onRuntimeError }) =>
			ports.createProcessingPipeline({ inputTrack, wasmNoiseSuppressionEnabled: enabled, onWasmError: onRuntimeError }),
		createGainPipeline: (inputStream, volume) =>
			shouldUseMicGainPipeline(volume) ? ports.createGainPipeline(inputStream, volume) : Promise.resolve(undefined),
		setGainVolume: (pipeline, volume) => {
			const currentTime = pipeline.audioContext.currentTime;
			pipeline.gainNode.gain.cancelScheduledValues(currentTime);
			pipeline.gainNode.gain.setValueAtTime(clampVolumePercent(volume) / 100, currentTime);
		},
		createProducerPublicationLease: () => {
			const transport = ports.getProducerTransport();
			if (!transport || transport.closed) return undefined;
			return {
				publish: (track) => {
					// Read channel settings at publication, not at construction or preparation.
					const audioConfig = getAudioOpusConfig(ports.getChannelSettings());
					return transport.produce({
						track,
						stopTracks: false,
						encodings: [{ maxBitrate: audioConfig.maxBitrate }],
						codecOptions: audioConfig.codecOptions,
						appData: { kind: StreamKind.AUDIO },
					});
				},
				isCurrent: () => ports.getProducerTransport() === transport && !transport.closed,
			};
		},
		publishLocalStream: ports.publishLocalStream,
		getProducerId: (producer) => producer.id,
		isProducerClosed: (producer) => producer.closed,
		closeProducer: (producer) => producer.close(),
		observeProducerClosed: (producer, onClosed) => producer.on('@close', onClosed),
		closeProducerOnServer: ports.closeProducerOnServer,
		getActivityMode: () => {
			const inputs = ports.getInputs();
			if (!inputs.isConnected || !ports.isTransmitGateOpen()) return 'inactive';
			return inputs.ownUserId === undefined ? 'unavailable' : 'monitor';
		},
		startActivityMonitor: (producer, onUpdate) => ports.startActivityMonitor({ statsProvider: producer, onUpdate }),
		// Keep broadcast authority scoped to the fenced producer; the sequence
		// remains monotonic across replacements so reordered mutations are safe.
		onActivityUpdate: (isSpeaking, producerId) => {
			const { ownUserId } = ports.getInputs();
			if (ownUserId === undefined) return;
			ports.setLocalActivity(ownUserId, isSpeaking);
			const { broadcast, state } = resolveActivityBroadcast(isSpeaking, producerId, activityBroadcastState);
			activityBroadcastState = state;
			if (broadcast === undefined || producerId === undefined) return;
			activitySequence += 1;
			ports.broadcastActivity({ isSpeaking: broadcast, seq: activitySequence, producerId });
		},
		isInVoiceChannel: () => getOwnerChannel() !== undefined,
		isMicMuted: ports.isMicMuted,
		isTransmitGateOpen: ports.isTransmitGateOpen,
		onTerminalOutputLoss: () => {
			commitTerminalMute();
			ports.error('Microphone capture stopped. Unmute to try again.');
		},
		reacquire: async (reason) => {
			recoveryBuilds = 0;
			recoveryReason = reason;
			recovering = true;
			settingsVersion += 1;
			try {
				return await start();
			} finally {
				recovering = false;
			}
		},
		onRecoveryExhausted: (reason) => {
			ports.log('Raw microphone recovery exhausted', { reason });
			ports.error('Microphone capture kept disconnecting and was stopped. Unmute to try again.');
			commitTerminalMute();
		},
		onProcessingRuntimeError: (error) => {
			ports.log('Browser WASM voice filter runtime error', { error });
			ports.error('Noise suppression encountered an error. Audio will continue without noise reduction.');
		},
		setTimeout: ports.setTimeout,
		clearTimeout: ports.clearTimeout,
		log: ports.log,
	});

	// Terminal capture loss: mute this owner's outbound track and processing
	// first, then commit muted state through the shared voice-state sequence.
	const commitTerminalMute = (): void => {
		controller.setMuted(true);
		ports.commitTerminalMicMuted();
		poke();
	};

	let settingsVersion = 0;
	let enabled = false;
	let publicationRequired = false;
	let ownerChannel: number | undefined;
	let recovering = false;
	let recoveryBuilds = 0;
	let recoveryReason: TMicrophoneRecoveryReason = 'ended';
	let ownerCurrent: () => boolean = () => true;
	let actual:
		| {
				pipeline: TMicrophonePreparedPipeline;
				session: number;
				channel: number;
				version: number;
				transport: Transport<AppData> | undefined;
		  }
		| undefined;
	let running = false;
	let lastSyncedCanSpeak: boolean | undefined;
	let dirty = false;
	type Waiter = { current: () => boolean; publication: boolean; resolve: (outcome: TMicrophoneStartOutcome) => void };
	const waiters = new Set<Waiter>();
	const preparedOwners = new WeakMap<TMicrophonePreparedPipeline, number>();
	const getOwnerChannel = () => ownerChannel ?? ports.getInputs().currentVoiceChannelId;
	const desired = () => {
		const channel = getOwnerChannel();
		const retain = enabled && ownerCurrent() && channel !== undefined && ports.canSpeak(channel);
		return {
			retain,
			wanted: retain && !ports.isMicMuted(),
			session: sessionGeneration,
			channel,
			version: settingsVersion,
		};
	};
	const action = () => {
		const next = desired();
		return resolveCaptureAction({
			wanted: next.wanted,
			retain: next.retain,
			present: actual !== undefined,
			matches:
				actual !== undefined &&
				controller.owns(actual.pipeline) &&
				actual.session === next.session &&
				actual.channel === next.channel &&
				actual.version === next.version &&
				controller.getRawTrack()?.readyState === 'live' &&
				actual.pipeline.outboundAudioTrack.readyState === 'live',
			publicationRequired:
				publicationRequired && ports.getProducerTransport() !== undefined && !ports.getProducerTransport()?.closed,
			published:
				actual !== undefined && actual.transport === ports.getProducerTransport() && controller.hasLiveProducer(),
		});
	};
	const settleWaiters = (failure?: TMicrophoneStartOutcome) => {
		for (const waiter of waiters) {
			let outcome: TMicrophoneStartOutcome | undefined;
			if (!waiter.current()) outcome = { status: 'superseded' };
			else if (failure) outcome = failure;
			else if (actual && action() === 'idle' && (!waiter.publication || actual.transport !== undefined))
				outcome = { status: 'started' };
			else if (!desired().wanted && !actual) outcome = { status: 'superseded' };
			if (outcome) {
				waiters.delete(waiter);
				waiter.resolve(outcome);
			}
		}
	};
	const poke = (): void => {
		dirty = true;
		if (running) return;
		running = true;
		void (async () => {
			try {
				while (dirty) {
					dirty = false;
					if (!ownerCurrent()) {
						const successor = [...waiters].find((waiter) => waiter.current());
						if (successor) ownerCurrent = successor.current;
					}
					const next = desired();
					// A restored session may adopt settled capture for the same channel.
					// Keep generation fences on in-flight work and prepared handles;
					// only live capture with unchanged settings can cross owners.
					if (
						actual &&
						actual.session !== next.session &&
						next.retain &&
						actual.channel === next.channel &&
						actual.version === next.version &&
						controller.owns(actual.pipeline) &&
						controller.getRawTrack()?.readyState === 'live' &&
						actual.pipeline.outboundAudioTrack.readyState === 'live'
					) {
						actual.session = next.session;
						actual.transport = undefined;
					}
					const owner = ownerCurrent;
					const token = action() === 'idle' ? undefined : ports.beginOperation();
					const current = () =>
						owner() &&
						next.session === sessionGeneration &&
						next.channel === desired().channel &&
						next.version === settingsVersion &&
						desired().retain;
					try {
						switch (action()) {
							case 'discard':
								actual = undefined;
								await controller.cleanup();
								dirty = true;
								break;
							case 'build': {
								if (recovering && recoveryBuilds++ > 0 && !controller.reserveRawRecoveryAttempt(recoveryReason)) {
									dirty = true;
									break;
								}
								const { devices } = ports.getInputs();
								const gainVolume = ports.getStoredVolume();
								const pipeline = await controller.prepare({
									...resolveMicCaptureConfig(devices),
									gainVolume,
									selectedMicrophoneId: devices.microphoneId,
									isCurrent: current,
								});
								if (current() && controller.getRawTrack()?.readyState !== 'live' && !recovering)
									void controller.recover('ended');
								if (current() && gainVolume !== ports.getStoredVolume())
									controller.setGainVolume(ports.getStoredVolume());
								if (!current()) {
									if (controller.owns(pipeline)) await controller.cleanup();
								} else if (next.channel !== undefined)
									actual = {
										pipeline,
										session: next.session,
										channel: next.channel,
										version: next.version,
										transport: undefined,
									};
								dirty = true;
								break;
							}
							case 'publish': {
								const capture = actual;
								if (!capture) break;
								const transport = ports.getProducerTransport();
								await controller.publish({ source: capture.pipeline, isCurrent: current });
								if (current()) {
									capture.transport = transport;
									ownerCurrent = () => true;
								}
								dirty = true;
								break;
							}
							case 'idle':
								break;
						}
					} catch (error) {
						if (!current() || error instanceof MicPipelineSupersededError) {
							if (!current()) {
								actual = undefined;
								await controller.cleanup();
							}
							dirty = true;
						} else {
							actual = undefined;
							await controller.cleanup();
							if (current() && token !== undefined && ports.isOperationCurrent(token)) {
								if (!recovering && ports.canSpeak(getOwnerChannel())) {
									commitTerminalMute();
									ports.error(getTrpcError(error, 'Failed to start microphone'));
								}
								settleWaiters({ status: 'failed', error });
							} else dirty = true;
						}
					}
					if (!dirty) settleWaiters();
				}
			} finally {
				running = false;
			}
		})();
	};
	const awaitSettle = (
		publication: boolean,
		isCurrent: () => boolean = () => true,
	): Promise<TMicrophoneStartOutcome> => {
		const channel = desired().channel;
		if (!isCurrent() || !controller.createLifecycleLease().isCurrent())
			return Promise.resolve({ status: 'superseded' });
		enabled = true;
		if (!ownerCurrent() || (!running && !actual)) {
			if (!ownerCurrent()) sessionGeneration += 1;
			ownerCurrent = isCurrent;
		}
		const session = sessionGeneration;
		const current = () => session === sessionGeneration && channel === getOwnerChannel() && isCurrent();
		const promise = new Promise<TMicrophoneStartOutcome>((resolve) => waiters.add({ current, publication, resolve }));
		publicationRequired ||= publication;
		poke();
		return promise;
	};
	const start = (isCurrent?: () => boolean) => awaitSettle(true, isCurrent);
	const prepare = async (
		isCurrent: () => boolean = () => true,
		channel = ports.getInputs().currentVoiceChannelId,
	): Promise<TMicrophonePreparedPipeline> => {
		if (!isCurrent() || !controller.createLifecycleLease().isCurrent()) throw new MicPipelineSupersededError();
		sessionGeneration += 1;
		ownerChannel = channel;
		ownerCurrent = isCurrent;
		const outcome = await awaitSettle(false, isCurrent);
		if (outcome.status === 'failed') throw outcome.error;
		if (outcome.status !== 'started' || !actual) throw new MicPipelineSupersededError();
		preparedOwners.set(actual.pipeline, sessionGeneration);
		return actual.pipeline;
	};
	const publish = async (source: TMicrophonePreparedPipeline | 'current', isCurrent?: () => boolean): Promise<void> => {
		if (source !== 'current' && preparedOwners.get(source) !== sessionGeneration)
			throw new MicPipelineSupersededError();
		const outcome = await start(isCurrent);
		if (outcome.status === 'failed') throw outcome.error;
		if (outcome.status !== 'started') throw new MicPipelineSupersededError();
	};
	const cleanup = () => {
		sessionGeneration += 1;
		enabled = false;
		publicationRequired = false;
		ownerChannel = undefined;
		actual = undefined;
		settleWaiters();
		return controller.cleanup();
	};
	const restart = (): Promise<TMicrophoneStartOutcome> => {
		settingsVersion += 1;
		return start();
	};

	const mountDefaultInputListener = (): (() => void) => {
		const mediaDevices = ports.getMediaDevices();
		if (!mediaDevices?.addEventListener) return () => {};
		const lifecycleLease = controller.createLifecycleLease();
		let mounted = true;
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let checkGeneration = 0;
		let handledMove: TDefaultInputMove | undefined;
		const clearRetryTimer = (): void => {
			if (retryTimer === undefined) return;
			ports.clearTimeout(retryTimer);
			retryTimer = undefined;
		};
		const cancelChecks = (): void => {
			checkGeneration += 1;
			clearRetryTimer();
		};
		const checkDefaultInput = async (isCurrent: () => boolean): Promise<'handled' | 'pending' | 'stop'> => {
			const rawTrack = controller.getRawTrack();
			if (!isCurrent() || rawTrack?.readyState !== 'live') return 'stop';
			let inputs: { deviceId: string; groupId: string }[];
			try {
				inputs = (await mediaDevices.enumerateDevices())
					.filter((device) => device.kind === 'audioinput')
					.map((device) => ({ deviceId: device.deviceId, groupId: device.groupId }));
			} catch (error) {
				ports.log('Failed to inspect default input after device change', { error });
				return 'pending';
			}
			// Enumeration may outlive listener cleanup or replacement capture. Its
			// result must never tear down or recover the successor's raw track.
			if (!isCurrent() || controller.getRawTrack() !== rawTrack || rawTrack.readyState !== 'live') return 'stop';
			const capturedGroupId = rawTrack.getSettings().groupId;
			const defaultGroupId = resolveDefaultInputGroupId(inputs);
			const decision = resolveDefaultInputRecoveryDecision({
				capturedGroupId,
				defaultGroupId,
				micMuted: ports.isMicMuted(),
				handledMove,
			});
			handledMove = decision.handledMove;
			if (decision.action === 'wait') return 'pending';
			if (decision.action === 'ignore-duplicate') return 'stop';
			if (decision.action === 'teardown-for-unmute') {
				ports.log('System default input moved while muted, tearing down mic for next unmute', {
					capturedGroupId,
					defaultGroupId,
				});
				void cleanup();
				return 'handled';
			}
			ports.log('System default input moved under a Default selection, re-acquiring mic', {
				capturedGroupId,
				defaultGroupId,
			});
			// The controller owns the retry budget across capture/publication
			// failures and subsequent loss from a successfully replaced raw track.
			await controller.recover('default-input-move');
			return 'handled';
		};
		const startChecks = (): void => {
			const generation = (checkGeneration += 1);
			const retryUntilMs = ports.now() + DEFAULT_INPUT_DEVICE_CHANGE_RETRY_WINDOW_MS;
			const isCurrent = (): boolean =>
				mounted &&
				lifecycleLease.isCurrent() &&
				generation === checkGeneration &&
				ports.getInputs().currentVoiceChannelId === defaultInputChannelId &&
				ports.getInputs().devices.microphoneId === undefined;
			const runCheck = async (): Promise<void> => {
				retryTimer = undefined;
				const result = await checkDefaultInput(isCurrent);
				if (!isCurrent() || result !== 'pending' || ports.now() >= retryUntilMs) return;
				retryTimer = ports.setTimeout(() => {
					void runCheck();
				}, DEFAULT_INPUT_DEVICE_CHANGE_RETRY_INTERVAL_MS);
			};
			void runCheck();
		};
		const handleDeviceChange = (): void => {
			if (!mounted || !lifecycleLease.isCurrent()) return;
			if (debounceTimer !== undefined) ports.clearTimeout(debounceTimer);
			cancelChecks();
			debounceTimer = ports.setTimeout(() => {
				debounceTimer = undefined;
				startChecks();
			}, DEFAULT_INPUT_DEVICE_CHANGE_DEBOUNCE_MS);
		};
		mediaDevices.addEventListener('devicechange', handleDeviceChange);
		return () => {
			mounted = false;
			if (debounceTimer !== undefined) ports.clearTimeout(debounceTimer);
			cancelChecks();
			mediaDevices.removeEventListener('devicechange', handleDeviceChange);
		};
	};

	const syncInputs = (): void => {
		if (!cleanupSubscriptions) return;
		controller.syncActivity();
		const { currentVoiceChannelId, devices, canSpeak } = ports.getInputs();
		// A SPEAK revoke discards capture; when SPEAK returns to a session that was
		// publishing, re-reconcile even with no capture so the unmuted user is heard.
		const speakChanged = lastSyncedCanSpeak !== undefined && canSpeak !== lastSyncedCanSpeak;
		lastSyncedCanSpeak = canSpeak;
		if (enabled && (actual || running || (speakChanged && publicationRequired))) poke();
		if (defaultInputChannelId === currentVoiceChannelId && selectedMicrophoneId === devices.microphoneId) return;
		cleanupDefaultInputListener?.();
		cleanupDefaultInputListener = undefined;
		defaultInputChannelId = currentVoiceChannelId;
		selectedMicrophoneId = devices.microphoneId;
		if (currentVoiceChannelId !== undefined && devices.microphoneId === undefined) {
			cleanupDefaultInputListener = mountDefaultInputListener();
		}
	};
	const activate = (): void => {
		if (cleanupSubscriptions) return;
		enabled = true;
		controller.activate();
		const eventTarget = ports.getVolumeEventTarget();
		let gainShape = shouldUseMicGainPipeline(ports.getStoredVolume());
		let mounted = true;
		const handleVolumeChange = (event: Event): void => {
			if (!mounted || !(event instanceof CustomEvent)) return;
			const detail: TVolumeSettingsUpdatedDetail = event.detail;
			if (detail.key !== OWN_MIC_VOLUME_KEY) return;
			const nextVolume = clampVolumePercent(detail.volume);
			const hadGainPipeline = gainShape;
			const nextShouldUseGainPipeline = shouldUseMicGainPipeline(nextVolume);
			gainShape = nextShouldUseGainPipeline;
			if (hadGainPipeline === nextShouldUseGainPipeline) {
				controller.setGainVolume(detail.volume);
				return;
			}
			const inputs = ports.getInputs();
			settingsVersion += 1;
			if (inputs.currentVoiceChannelId === undefined || (!actual && !running)) return;
			ports.log('Rebuilding microphone pipeline after mic volume crossed neutral threshold', {
				nextVolume,
				hadMicGainPipeline: hadGainPipeline,
				nextShouldUseMicGainPipeline: nextShouldUseGainPipeline,
			});
			void start();
		};
		eventTarget.addEventListener(VOLUME_SETTINGS_UPDATED_EVENT, handleVolumeChange);
		const cleanup = (): void => {
			if (!mounted) return;
			mounted = false;
			eventTarget.removeEventListener(VOLUME_SETTINGS_UPDATED_EVENT, handleVolumeChange);
			cleanupDefaultInputListener?.();
			cleanupDefaultInputListener = undefined;
			defaultInputChannelId = undefined;
			selectedMicrophoneId = undefined;
		};
		cleanupSubscriptions = cleanup;
		syncInputs();
	};
	const deactivate = (): Promise<void> => {
		// Fence capture synchronously before removing subscriptions; resource
		// destruction may continue after this retained instance is reactivated.
		sessionGeneration += 1;
		enabled = false;
		actual = undefined;
		ownerChannel = undefined;
		publicationRequired = false;
		settleWaiters();
		const cleanupPromise = controller.deactivate();
		cleanupSubscriptions?.();
		cleanupSubscriptions = undefined;
		return cleanupPromise;
	};

	return {
		activate,
		deactivate,
		syncInputs,
		prepare,
		publish,
		start,
		restart,
		resetRawRecoveryBudget: controller.resetRawRecoveryBudget,
		cleanup,
		setMuted: (muted: boolean) => {
			controller.setMuted(muted);
			controller.syncActivity();
			poke();
		},
		commitTerminalMute,
		owns: controller.owns,
		getRawTrack: controller.getRawTrack,
		createLifecycleLease: controller.createLifecycleLease,
	};
};

type TMicrophoneIntegration = ReturnType<typeof createMicrophoneIntegration>;
const mountMicrophoneIntegration = (integration: TMicrophoneIntegration): (() => void) =>
	mountMicrophonePipelineController(integration);

export type { TMicrophoneIntegrationInputs, TMicrophoneIntegrationPorts };

const resolveCaptureAction = (state: {
	wanted: boolean;
	retain: boolean;
	present: boolean;
	matches: boolean;
	publicationRequired: boolean;
	published: boolean;
}): 'discard' | 'build' | 'publish' | 'idle' => {
	if (state.present && (!state.retain || !state.matches)) return 'discard';
	if (!state.present) return state.wanted ? 'build' : 'idle';
	if (state.publicationRequired && !state.published) return 'publish';
	return 'idle';
};

export { createMicrophoneIntegration, mountMicrophoneIntegration, resolveCaptureAction };
