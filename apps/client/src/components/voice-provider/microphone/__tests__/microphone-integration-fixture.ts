import type { AppData, Producer, ProducerOptions, Transport } from 'mediasoup-client/types';
import { DEFAULT_DEVICE_SETTINGS } from '../../../devices-provider/migrate-device-settings';
import { OWN_MIC_VOLUME_KEY, VOLUME_SETTINGS_UPDATED_EVENT } from '../../volume-control-storage';
import type { TMicGainPipeline } from '../mic-gain-pipeline';
import {
	createMicrophoneIntegration,
	mountMicrophoneIntegration,
	type TMicrophoneIntegrationInputs,
	type TMicrophoneIntegrationPorts,
} from '../microphone-integration';

const deferred = <T>() => {
	let resolve: (value: T) => void = () => {
		throw new Error('Promise not initialized');
	};
	let reject: (error: unknown) => void = () => {
		throw new Error('Promise not initialized');
	};
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
};
const flush = async (): Promise<void> => {
	for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
};
const createScheduler = () => {
	let now = 0;
	const timers = new Map<ReturnType<typeof setTimeout>, { due: number; callback: () => void }>();
	return {
		now: () => now,
		setTimeout: (callback: () => void, milliseconds: number) => {
			const handle = setTimeout(() => {}, 2_000_000_000);
			handle.unref();
			timers.set(handle, { due: now + milliseconds, callback });
			return handle;
		},
		clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
			clearTimeout(handle);
			timers.delete(handle);
		},
		advance: (milliseconds: number) => {
			const until = now + milliseconds;
			while (true) {
				const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
				if (!next || next[1].due > until) break;
				const [handle, timer] = next;
				clearTimeout(handle);
				timers.delete(handle);
				now = timer.due;
				timer.callback();
			}
			now = until;
		},
		pending: () => timers.size,
	};
};
const createStream = (groupId = 'physical-a') => {
	let readyState: MediaStreamTrackState = 'live';
	const track = Object.assign(new EventTarget(), {
		enabled: true,
		muted: false,
		onended: null,
		label: groupId,
		getSettings: () => ({ groupId, deviceId: `${groupId}-device` }),
		stop: () => {
			readyState = 'ended';
		},
	}) as unknown as MediaStreamTrack;
	Object.defineProperty(track, 'readyState', { get: () => readyState });
	return { track, getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream & {
		track: MediaStreamTrack;
	};
};
const createProducer = (id: string) => {
	let closed = false;
	const listeners: Array<() => void> = [];
	return {
		id,
		get closed() {
			return closed;
		},
		on: (_event: string, callback: () => void) => {
			listeners.push(callback);
		},
		close: () => {
			if (closed) return;
			closed = true;
			listeners.forEach((listener) => listener());
		},
	} as unknown as Producer<AppData>;
};
const defaultInput = (groupId: string): MediaDeviceInfo => ({
	deviceId: 'default',
	groupId,
	kind: 'audioinput',
	label: 'Default',
	toJSON: () => ({}),
});

const createHarness = () => {
	const scheduler = createScheduler();
	const events = new EventTarget();
	const deviceEvents = new EventTarget();
	const captures: MediaStreamConstraints[] = [];
	const streams: ReturnType<typeof createStream>[] = [];
	const captureResults: Array<Promise<MediaStream>> = [];
	const publicationResults: Array<Promise<Producer<AppData>>> = [];
	const enumerations: Array<Promise<MediaDeviceInfo[]>> = [];
	const publications: Array<{ transport: Transport<AppData>; options: ProducerOptions<AppData> }> = [];
	const producers: Producer<AppData>[] = [];
	const gains: Array<{ pipeline: TMicGainPipeline; volume: number; updates: number[]; destroyed: boolean }> = [];
	const monitors: Array<{ onUpdate: (isSpeaking: boolean | undefined) => void; removed: boolean }> = [];
	const broadcasts: Array<{ isSpeaking: boolean; seq: number; producerId: string }> = [];
	const localActivity: Array<{ userId: number; isSpeaking: boolean | undefined }> = [];
	const errors: string[] = [];
	const closedOnServer: string[] = [];
	const processingInputs: Array<Parameters<TMicrophoneIntegrationPorts['createProcessingPipeline']>[0]> = [];
	const terminalCommitTrackStates: Array<boolean | undefined> = [];
	const inputs: TMicrophoneIntegrationInputs = {
		devices: { ...DEFAULT_DEVICE_SETTINGS },
		currentVoiceChannelId: 1,
		localAudioStream: undefined,
		hasServerSession: true,
		canSpeak: true,
		ownUserId: 10,
	};
	const state: {
		operation: number;
		gateOpen: boolean;
		volume: number;
		micMuted: boolean;
		talkHeld: boolean;
		captureGroupId: string;
		defaultGroupId: string;
		terminalMutes: number;
		enumerationCalls: number;
		environmentReads: number;
		transport: Transport<AppData> | undefined;
		channelSettings: { voiceBitrate: number; voiceDtx: boolean };
	} = {
		operation: 0,
		gateOpen: true,
		volume: 100,
		micMuted: false,
		talkHeld: false,
		captureGroupId: 'physical-a',
		defaultGroupId: 'physical-a',
		terminalMutes: 0,
		enumerationCalls: 0,
		environmentReads: 0,
		transport: undefined,
		channelSettings: { voiceBitrate: 96_000, voiceDtx: false },
	};
	const newTransport = () => {
		const transport = {
			closed: false,
			produce: (options: ProducerOptions<AppData>) => {
				publications.push({ transport, options });
				if (!inputs.canSpeak) return Promise.reject(new Error('missing SPEAK permission'));
				const pending = publicationResults.shift();
				if (pending) return pending;
				const producer = createProducer(`producer-${producers.length + 1}`);
				producer.on('@close', () => {
					if (options.stopTracks !== false) options.track?.stop();
				});
				producers.push(producer);
				return Promise.resolve(producer);
			},
		} as unknown as Transport<AppData>;
		state.transport = transport;
		return transport;
	};
	newTransport();
	const mediaDevices = Object.assign(deviceEvents, {
		getUserMedia: (constraints: MediaStreamConstraints) => {
			captures.push(constraints);
			const pending = captureResults.shift();
			if (pending) return pending;
			const stream = createStream(state.captureGroupId);
			streams.push(stream);
			return Promise.resolve(stream);
		},
		enumerateDevices: () => {
			state.enumerationCalls += 1;
			return enumerations.shift() ?? Promise.resolve([defaultInput(state.defaultGroupId)]);
		},
	}) as unknown as MediaDevices;
	const integration = createMicrophoneIntegration({
		getInputs: () => inputs,
		canSpeak: () => inputs.canSpeak,
		isMicMuted: () => state.micMuted && !state.talkHeld,
		isTransmitGateOpen: () => state.gateOpen && (!state.micMuted || state.talkHeld),
		beginOperation: () => (state.operation += 1),
		isOperationCurrent: (token) => token === state.operation,
		getProducerTransport: () => state.transport,
		getChannelSettings: () => state.channelSettings,
		getMediaDevices: () => {
			state.environmentReads += 1;
			return mediaDevices;
		},
		getVolumeEventTarget: () => {
			state.environmentReads += 1;
			return events;
		},
		getStoredVolume: () => state.volume,
		createProcessingPipeline: (input) => {
			processingInputs.push(input);
			if (!input.wasmNoiseSuppressionEnabled) return Promise.resolve(undefined);
			const stream = createStream('wasm');
			return Promise.resolve({
				sessionId: 'wasm',
				sampleRate: 48000,
				channels: 1,
				framesPerBuffer: 480,
				stream,
				track: stream.track,
				backend: 'browser-wasm' as const,
				setInputMuted: () => {},
				destroy: async () => {
					stream.track.stop();
				},
			});
		},
		createGainPipeline: async (_stream, volume) => {
			const stream = createStream('gain');
			const updates: number[] = [];
			const record: { pipeline: TMicGainPipeline; volume: number; updates: number[]; destroyed: boolean } = {
				pipeline: {
					stream,
					track: stream.track,
					audioContext: { currentTime: 12 } as AudioContext,
					gainNode: {
						gain: { cancelScheduledValues: () => {}, setValueAtTime: (value: number) => updates.push(value) },
					} as unknown as GainNode,
					destroy: () => {
						record.destroyed = true;
						return Promise.resolve();
					},
				},
				volume,
				updates,
				destroyed: false,
			};
			gains.push(record);
			return record.pipeline;
		},
		publishLocalStream: (stream) => {
			inputs.localAudioStream = stream;
			return {
				stream,
				remove: () => {
					if (inputs.localAudioStream === stream) inputs.localAudioStream = undefined;
				},
			};
		},
		closeProducerOnServer: (id) => {
			closedOnServer.push(id);
		},
		startActivityMonitor: ({ onUpdate }) => {
			const monitor = { onUpdate, removed: false };
			monitors.push(monitor);
			return () => {
				monitor.removed = true;
			};
		},
		setLocalActivity: (userId, isSpeaking) => {
			localActivity.push({ userId, isSpeaking });
		},
		broadcastActivity: (activity) => {
			broadcasts.push(activity);
		},
		commitTerminalMicMuted: () => {
			state.talkHeld = false;
			terminalCommitTrackStates.push(inputs.localAudioStream?.getAudioTracks()[0]?.enabled);
			state.terminalMutes += 1;
			state.micMuted = true;
		},
		error: (message) => {
			errors.push(message);
		},
		log: () => {},
		now: scheduler.now,
		setTimeout: scheduler.setTimeout,
		clearTimeout: scheduler.clearTimeout,
	});
	return {
		integration,
		inputs,
		state,
		captures,
		streams,
		captureResults,
		publicationResults,
		enumerations,
		publications,
		producers,
		gains,
		monitors,
		broadcasts,
		localActivity,
		processingInputs,
		terminalCommitTrackStates,
		errors,
		closedOnServer,
		scheduler,
		newTransport,
		mount: () => mountMicrophoneIntegration(integration),
		deviceChange: () => deviceEvents.dispatchEvent(new Event('devicechange')),
		volumeChange: (volume: number, key = OWN_MIC_VOLUME_KEY) => {
			state.volume = volume;
			events.dispatchEvent(new CustomEvent(VOLUME_SETTINGS_UPDATED_EVENT, { detail: { volume, key } }));
		},
	};
};

export { createHarness, createProducer, createStream, defaultInput, deferred, flush };
