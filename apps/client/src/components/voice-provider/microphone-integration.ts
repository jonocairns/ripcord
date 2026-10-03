import { StreamKind, type TPublicChannel } from '@sharkord/shared';
import type { AppData, Producer, Transport } from 'mediasoup-client/types';
import type { TDeviceSettings } from '@/types';
import { getAudioOpusConfig } from './audio-producer-config';
import {
	resolveDefaultInputGroupId,
	resolveDefaultInputRecoveryDecision,
	type TDefaultInputMove,
} from './default-input-device';
import { mountMicrophonePipelineController } from './hooks/use-microphone-pipeline-controller-lifecycle';
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
	type TMicrophoneStartOutcome,
} from './microphone-pipeline-controller';
import {
	OWN_MIC_VOLUME_KEY,
	type TVolumeSettingsUpdatedDetail,
	VOLUME_SETTINGS_UPDATED_EVENT,
} from './volume-control-storage';

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
	ownUserId: number | undefined;
};

type TMicrophoneIntegrationPorts = {
	getInputs: () => TMicrophoneIntegrationInputs;
	isMicMuted: () => boolean;
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
	commitTerminalMicMuted: () => void;
	error: (message: string) => void;
	log: (message: string, context?: Record<string, unknown>) => void;
	now: () => number;
	setTimeout: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
};

const createMicrophoneIntegration = (ports: TMicrophoneIntegrationPorts) => {
	let pipelineMutex: Promise<void> = Promise.resolve();
	let volumeRestartPromise: Promise<void> | undefined;
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
			if (!inputs.isConnected || ports.isMicMuted()) return 'inactive';
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
		isInVoiceChannel: () => ports.getInputs().currentVoiceChannelId !== undefined,
		isMicMuted: ports.isMicMuted,
		reacquire: () => start(),
		onRecoveryExhausted: (reason) => {
			ports.log('Raw microphone recovery exhausted', { reason });
			ports.error('Microphone capture kept disconnecting and was stopped. Unmute to try again.');
			ports.commitTerminalMicMuted();
		},
		onProcessingRuntimeError: (error) => {
			ports.log('Browser WASM voice filter runtime error', { error });
			ports.error('Noise suppression encountered an error. Audio will continue without noise reduction.');
		},
		setTimeout: ports.setTimeout,
		clearTimeout: ports.clearTimeout,
		log: ports.log,
	});

	// Preparation deliberately has no transport dependency: session setup starts
	// capture/processing in parallel with device loading and transport creation.
	const prepare = (isCurrent?: () => boolean): Promise<TMicrophonePreparedPipeline> => {
		const { devices } = ports.getInputs();
		return controller.prepare({
			...resolveMicCaptureConfig(devices),
			gainVolume: ports.getStoredVolume(),
			selectedMicrophoneId: devices.microphoneId,
			isCurrent,
		});
	};
	const publish = (source: TMicrophonePreparedPipeline | 'current', isCurrent?: () => boolean): Promise<void> =>
		controller.publish({ source, isCurrent });

	const start = async (isCurrent?: () => boolean): Promise<TMicrophoneStartOutcome> => {
		const lifecycleLease = controller.createLifecycleLease();
		const isStartCurrent = (): boolean => lifecycleLease.isCurrent() && (isCurrent?.() ?? true);
		const previousMutex = pipelineMutex;
		let releaseMutex: () => void = () => {};
		pipelineMutex = new Promise<void>((resolve) => {
			releaseMutex = resolve;
		});
		let prepared: TMicrophonePreparedPipeline | undefined;
		try {
			await previousMutex;
			if (!isStartCurrent()) return { status: 'superseded' };
			ports.log('Starting microphone stream');
			// Unlike the previous render-captured callback, queued starts resolve
			// committed device settings here, when they actually enter the mutex.
			prepared = await prepare(isStartCurrent);
			await publish(prepared, isStartCurrent);
			return { status: 'started' };
		} catch (error) {
			ports.log('Error starting microphone stream', { error });
			if (prepared && controller.owns(prepared)) await controller.cleanup();
			return error instanceof MicPipelineSupersededError || !isStartCurrent()
				? { status: 'superseded' }
				: { status: 'failed', error };
		} finally {
			releaseMutex();
		}
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
				void controller.cleanup();
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
		const { currentVoiceChannelId, devices } = ports.getInputs();
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
		controller.activate();
		const eventTarget = ports.getVolumeEventTarget();
		let mounted = true;
		const handleVolumeChange = (event: Event): void => {
			if (!mounted || !(event instanceof CustomEvent)) return;
			const detail: TVolumeSettingsUpdatedDetail = event.detail;
			if (detail.key !== OWN_MIC_VOLUME_KEY) return;
			const nextVolume = clampVolumePercent(detail.volume);
			const hadGainPipeline = controller.hasGainPipeline();
			const nextShouldUseGainPipeline = shouldUseMicGainPipeline(nextVolume);
			if (hadGainPipeline === nextShouldUseGainPipeline) {
				controller.setGainVolume(detail.volume);
				return;
			}
			const inputs = ports.getInputs();
			if (inputs.currentVoiceChannelId === undefined || inputs.localAudioStream === undefined || volumeRestartPromise)
				return;
			ports.log('Rebuilding microphone pipeline after mic volume crossed neutral threshold', {
				nextVolume,
				hadMicGainPipeline: hadGainPipeline,
				nextShouldUseMicGainPipeline: nextShouldUseGainPipeline,
			});
			volumeRestartPromise = (async () => {
				const outcome = await start();
				if (outcome.status === 'failed') {
					ports.log('Failed to rebuild microphone pipeline after mic volume change', {
						error: outcome.error,
						nextVolume,
					});
					ports.error('Failed to apply microphone volume');
				}
				volumeRestartPromise = undefined;
			})();
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
		cleanup: controller.cleanup,
		setMuted: controller.setMuted,
		owns: controller.owns,
		getRawTrack: controller.getRawTrack,
		createLifecycleLease: controller.createLifecycleLease,
	};
};

type TMicrophoneIntegration = ReturnType<typeof createMicrophoneIntegration>;
const mountMicrophoneIntegration = (integration: TMicrophoneIntegration): (() => void) =>
	mountMicrophonePipelineController(integration);

export type { TMicrophoneIntegrationInputs, TMicrophoneIntegrationPorts };
export { createMicrophoneIntegration, mountMicrophoneIntegration };
