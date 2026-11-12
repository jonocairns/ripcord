import { describe, expect, it } from 'bun:test';
import type { AppData, Producer, ProducerOptions, Transport } from 'mediasoup-client/types';
import { DEFAULT_DEVICE_SETTINGS } from '../../../devices-provider/migrate-device-settings';
import { createOwnMicControls } from '../../own-mic-controls';
import { recoverTransportMicrophone } from '../../session/transport-recovery-microphone';
import { OWN_MIC_VOLUME_KEY, VOLUME_SETTINGS_UPDATED_EVENT } from '../../volume-control-storage';
import type { TMicGainPipeline } from '../mic-gain-pipeline';
import {
	createMicrophoneIntegration,
	mountMicrophoneIntegration,
	resolveCaptureAction,
	type TMicrophoneIntegrationInputs,
	type TMicrophoneIntegrationPorts,
} from '../microphone-integration';
import { MicPipelineSupersededError } from '../microphone-pipeline-controller';

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
		isConnected: true,
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
				const pending = publicationResults.shift();
				if (pending) return pending;
				const producer = createProducer(`producer-${producers.length + 1}`);
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

describe('microphone integration', () => {
	it('acquires no environment resources during construction and rejects work before mounting', async () => {
		const h = createHarness();
		expect(h.state.environmentReads).toBe(0);
		expect(await h.integration.start()).toEqual({ status: 'superseded' });
		await expect(h.integration.prepare()).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(h.captures).toHaveLength(0);
		expect(h.scheduler.pending()).toBe(0);
	});
	it('restarts across the neutral gain threshold and updates an existing gain graph in place', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		expect(await h.integration.start()).toEqual({ status: 'started' });
		h.volumeChange(70);
		await flush();
		expect(h.captures).toHaveLength(2);
		expect(h.gains.map((gain) => gain.volume)).toEqual([70]);
		expect(h.streams[0]?.track.readyState).toBe('ended');
		h.volumeChange(45);
		expect(h.captures).toHaveLength(2);
		expect(h.gains[0]?.updates).toEqual([0.45]);
		h.volumeChange(150);
		await flush();
		expect(h.captures).toHaveLength(3);
		expect(h.gains[0]?.destroyed).toBe(true);
		expect(h.inputs.localAudioStream).toBe(h.streams[2]);
		cleanup();
		expect(h.scheduler.pending()).toBe(0);
	});
	it('ignores unrelated volume events and avoids starting without channel or publication', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		h.volumeChange(50);
		await flush();
		expect(h.captures).toHaveLength(0);
		h.state.volume = 100;
		await h.integration.start();
		h.volumeChange(50, 'remote-user');
		h.inputs.currentVoiceChannelId = undefined;
		h.volumeChange(50);
		await flush();
		expect(h.captures).toHaveLength(1);
		cleanup();
	});
	it('coalesces threshold restarts and reports failure without blocking later work', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		const capture = deferred<MediaStream>();
		h.captureResults.push(capture.promise);
		h.volumeChange(70);
		h.volumeChange(50);
		await flush();
		expect(h.captures).toHaveLength(2);
		capture.reject(new Error('capture unavailable'));
		await flush();
		expect(h.errors).toEqual(['Failed to start microphone']);
		h.state.micMuted = false;
		expect(await h.integration.start()).toEqual({ status: 'started' });
		h.volumeChange(100);
		await flush();
		expect(h.captures).toHaveLength(4);
		cleanup();
	});
	it('supersedes a queued volume restart across lifecycle cleanup and replay', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		const publication = deferred<Producer<AppData>>();
		h.publicationResults.push(publication.promise);
		const start = h.integration.start();
		await flush();
		h.volumeChange(50);
		cleanup();
		expect(h.inputs.localAudioStream).toBeUndefined();
		const replayCleanup = h.mount();
		const preparing = h.integration.prepare();
		const oldProducer = createProducer('old-producer');
		publication.resolve(oldProducer);
		const prepared = await preparing;
		await h.integration.publish(prepared);
		expect(await start).toEqual({ status: 'superseded' });
		await flush();
		expect(oldProducer.closed).toBe(true);
		expect(h.captures).toHaveLength(2);
		expect(h.inputs.localAudioStream).toBe(prepared.outboundStream);
		expect(h.errors).toEqual([]);
		cleanup();
		expect(h.integration.owns(prepared)).toBe(true);
		replayCleanup();
	});
	it('reads current committed settings when a queued reconciliation builds', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		h.inputs.devices = { ...h.inputs.devices, microphoneId: 'old-input' };
		const capture = deferred<MediaStream>();
		h.captureResults.push(capture.promise);
		const first = h.integration.start();
		await flush();
		const queued = h.integration.restart();
		h.inputs.devices = { ...h.inputs.devices, microphoneId: 'new-input', wasmNoiseSuppressionEnabled: true };
		h.state.volume = 40;
		capture.resolve(createStream());
		expect(await first).toEqual({ status: 'started' });
		expect(await queued).toEqual({ status: 'started' });
		expect(h.captures.map((capture) => capture.audio)).toEqual([
			{
				deviceId: { exact: 'old-input' },
				autoGainControl: true,
				echoCancellation: true,
				noiseSuppression: true,
				sampleRate: 48000,
			},
			{
				deviceId: { exact: 'new-input' },
				autoGainControl: true,
				echoCancellation: true,
				noiseSuppression: false,
				sampleRate: 48000,
			},
		]);
		expect(h.processingInputs.map((input) => input.wasmNoiseSuppressionEnabled)).toEqual([true]);
		expect(h.gains.map((gain) => gain.volume)).toEqual([40]);
		cleanup();
	});
	it('prepares without transport and reads publication-time channel settings and mute intent', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		h.state.transport = undefined;
		const prepared = await h.integration.prepare();
		expect(h.publications).toHaveLength(0);
		expect(h.inputs.localAudioStream).toBeUndefined();
		h.newTransport();
		h.state.channelSettings = { voiceBitrate: 48_000, voiceDtx: true };
		h.state.micMuted = true;
		await expect(h.integration.publish(prepared)).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(prepared.outboundAudioTrack.readyState).toBe('ended');
		expect(h.publications).toHaveLength(0);
		cleanup();
	});
	for (const boundary of ['cleanup', 'replacement'] as const) {
		it(`disposes stale capture after ${boundary} without removing a successor publication`, async () => {
			const h = createHarness();
			const cleanup = h.mount();
			const capture = deferred<MediaStream>();
			h.captureResults.push(capture.promise);
			const oldResult = h.integration.prepare().catch((error: unknown) => error);
			await flush();
			if (boundary === 'cleanup') cleanup();
			const replayCleanup = boundary === 'cleanup' ? h.mount() : cleanup;
			const preparing = h.integration.prepare();
			const oldStream = createStream('old-capture');
			capture.resolve(oldStream);
			const prepared = await preparing;
			await h.integration.publish(prepared);
			expect(await oldResult).toBeInstanceOf(MicPipelineSupersededError);
			expect(oldStream.track.readyState).toBe('ended');
			expect(h.inputs.localAudioStream).toBe(prepared.outboundStream);
			expect(prepared.outboundAudioTrack.readyState).toBe('live');
			replayCleanup();
		});
	}
	it('retains lifecycle currency across replay and rejects old preparation and publication', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		const lifecycle = h.integration.createLifecycleLease();
		const prepared = await h.integration.prepare(lifecycle.isCurrent);
		const publication = deferred<Producer<AppData>>();
		h.publicationResults.push(publication.promise);
		const pending = h.integration.publish(prepared, lifecycle.isCurrent).catch((error: unknown) => error);
		cleanup();
		expect(lifecycle.isCurrent()).toBe(false);
		expect(prepared.outboundAudioTrack.readyState).toBe('ended');
		const replayCleanup = h.mount();
		const preparing = h.integration.prepare();
		const staleProducer = createProducer('stale');
		publication.resolve(staleProducer);
		const fresh = await preparing;
		await h.integration.publish(fresh);
		expect(await pending).toBeInstanceOf(MicPipelineSupersededError);
		expect(staleProducer.closed).toBe(true);
		await expect(h.integration.prepare(lifecycle.isCurrent)).rejects.toBeInstanceOf(MicPipelineSupersededError);
		await expect(h.integration.publish(prepared)).rejects.toBeInstanceOf(MicPipelineSupersededError);
		expect(h.integration.owns(fresh)).toBe(true);
		expect(h.inputs.localAudioStream).toBe(fresh.outboundStream);
		replayCleanup();
	});
	it('closes a late producer from a replaced transport and preserves capture for republishing', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		const prepared = await h.integration.prepare();
		const publication = deferred<Producer<AppData>>();
		h.publicationResults.push(publication.promise);
		const pending = h.integration.publish(prepared).catch((error: unknown) => error);
		h.newTransport();
		const republishing = h.integration.publish('current');
		const staleProducer = createProducer('stale-transport');
		publication.resolve(staleProducer);
		await republishing;
		expect(await pending).toBeUndefined();
		expect(staleProducer.closed).toBe(true);
		expect(h.closedOnServer).toContain('stale-transport');
		expect(prepared.outboundAudioTrack.readyState).toBe('live');
		expect(h.captures).toHaveLength(1);
		cleanup();
	});
	it('fences activity by producer identity and orders broadcasts across replacements', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		const oldMonitor = h.monitors[0];
		if (!oldMonitor) throw new Error('Expected activity monitor');
		oldMonitor.onUpdate(false);
		oldMonitor.onUpdate(true);
		await h.integration.restart();
		expect(oldMonitor.removed).toBe(true);
		oldMonitor.onUpdate(true);
		const monitor = h.monitors[1];
		if (!monitor) throw new Error('Expected replacement monitor');
		monitor.onUpdate(false);
		h.inputs.ownUserId = 20;
		monitor.onUpdate(true);
		h.inputs.isConnected = false;
		h.integration.syncInputs();
		expect(monitor.removed).toBe(true);
		expect(h.broadcasts).toEqual([
			{ isSpeaking: true, seq: 1, producerId: 'producer-1' },
			{ isSpeaking: false, seq: 2, producerId: 'producer-1' },
			{ isSpeaking: true, seq: 3, producerId: 'producer-2' },
			{ isSpeaking: false, seq: 4, producerId: 'producer-2' },
		]);
		expect(h.localActivity.at(-1)).toEqual({ userId: 20, isSpeaking: false });
		cleanup();
	});
	for (const muted of [false, true]) {
		it(`handles default-input movement by ${muted ? 'tearing down for unmute' : 'reacquiring through recovery'}`, async () => {
			const h = createHarness();
			const cleanup = h.mount();
			await h.integration.start();
			h.state.micMuted = muted;
			h.integration.setMuted(muted);
			h.state.defaultGroupId = 'physical-b';
			h.state.captureGroupId = 'physical-b';
			h.deviceChange();
			h.deviceChange();
			h.scheduler.advance(499);
			expect(h.state.enumerationCalls).toBe(0);
			h.scheduler.advance(1);
			await flush();
			expect(h.streams[0]?.track.readyState).toBe('ended');
			expect(h.captures).toHaveLength(muted ? 1 : 2);
			expect(h.inputs.localAudioStream).toBe(muted ? undefined : h.streams[1]);
			expect(h.state.terminalMutes).toBe(0);
			cleanup();
		});
	}
	it('deduplicates a handled default-input move when capture stays on the old group', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		h.state.defaultGroupId = 'physical-b';
		h.deviceChange();
		h.scheduler.advance(500);
		await flush();
		expect(h.captures).toHaveLength(2);
		h.deviceChange();
		h.scheduler.advance(500);
		await flush();
		expect(h.captures).toHaveLength(2);
		expect(h.scheduler.pending()).toBe(1); // Only the controller's stability timer.
		cleanup();
	});
	it('waits for default-device metadata within the existing bounded polling window', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		h.enumerations.push(Promise.resolve([defaultInput('')]));
		h.deviceChange();
		h.scheduler.advance(500);
		await flush();
		expect(h.captures).toHaveLength(1);
		h.state.defaultGroupId = 'physical-b';
		h.state.captureGroupId = 'physical-b';
		h.scheduler.advance(250);
		await flush();
		expect(h.state.enumerationCalls).toBe(2);
		expect(h.captures).toHaveLength(2);
		h.deviceChange();
		h.scheduler.advance(500);
		await flush();
		for (let retry = 0; retry < 6; retry += 1) {
			h.scheduler.advance(250);
			await flush();
		}
		expect(h.state.enumerationCalls).toBe(9);
		expect(h.captures).toHaveLength(2);
		expect(h.scheduler.pending()).toBe(1);
		cleanup();
	});
	it('keeps failed default-input retries and terminal mute in the existing controller', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		h.state.defaultGroupId = 'physical-b';
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const capture = deferred<MediaStream>();
			capture.reject(new Error('capture lost'));
			h.captureResults.push(capture.promise);
		}
		h.deviceChange();
		h.scheduler.advance(500);
		await flush();
		expect(h.captures).toHaveLength(4);
		expect(h.state.terminalMutes).toBe(1);
		expect(h.inputs.localAudioStream).toBeUndefined();
		expect(h.integration.getRawTrack()).toBeUndefined();
		h.state.micMuted = false;
		h.integration.resetRawRecoveryBudget();
		h.integration.setMuted(false);
		expect(await h.integration.start()).toEqual({ status: 'started' });
		cleanup();
	});
	it('mutes its own live capture before committing terminal muted state', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		const track = h.inputs.localAudioStream?.getAudioTracks()[0];
		expect(track?.enabled).toBe(true);
		h.integration.commitTerminalMute();
		expect(h.terminalCommitTrackStates).toEqual([false]);
		expect(h.state.terminalMutes).toBe(1);
		expect(track?.readyState).toBe('ended');
		cleanup();
	});
	for (const boundary of ['cleanup', 'replacement', 'selection', 'channel'] as const) {
		it(`ignores deferred device enumeration after ${boundary}`, async () => {
			const h = createHarness();
			const cleanup = h.mount();
			await h.integration.start();
			const devices = deferred<MediaDeviceInfo[]>();
			h.enumerations.push(devices.promise);
			h.deviceChange();
			h.scheduler.advance(500);
			await flush();
			expect(h.state.enumerationCalls).toBe(1);
			if (boundary === 'cleanup') cleanup();
			if (boundary === 'replacement') await h.integration.restart();
			if (boundary === 'selection') h.inputs.devices = { ...h.inputs.devices, microphoneId: 'explicit' };
			if (boundary === 'channel') h.inputs.currentVoiceChannelId = 2;
			if (boundary === 'selection' || boundary === 'channel') h.integration.syncInputs();
			h.state.micMuted = true;
			const currentStream = h.inputs.localAudioStream;
			devices.resolve([defaultInput('physical-b')]);
			await flush();
			expect(h.inputs.localAudioStream).toBe(currentStream);
			expect(h.captures).toHaveLength(boundary === 'replacement' ? 2 : 1);
			expect(h.scheduler.pending()).toBe(boundary === 'cleanup' || boundary === 'channel' ? 0 : 1);
			cleanup();
		});
	}
});

describe('capture restart policy', () => {
	for (const demand of ['unmuted', 'talk held'])
		it(`settings restart failure fails closed for ${demand}`, async () => {
			const h = createHarness();
			h.state.micMuted = demand === 'talk held';
			h.state.talkHeld = demand === 'talk held';
			const cleanup = h.mount();
			await h.integration.start();
			h.captureResults.push(Promise.reject(new Error('settings acquisition')));
			expect((await h.integration.restart()).status).toBe('failed');
			expect(h.state.terminalMutes).toBe(1);
			expect(h.errors).toEqual(['Failed to start microphone']);
			cleanup();
		});
	it('skips settings and volume restarts when capture is not wanted', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		await h.integration.start();
		h.state.micMuted = true;
		expect((await h.integration.restart()).status).toBe('superseded');
		h.volumeChange(50);
		await flush();
		expect(h.captures).toHaveLength(1);
		cleanup();
	});
	it('a settings acquisition failure cannot mute a newer operation', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		const pending = deferred<MediaStream>();
		h.captureResults.push(pending.promise);
		const old = h.integration.restart();
		await flush();
		h.state.operation += 1;
		pending.reject(new Error('old'));
		await old;
		expect(h.state.terminalMutes).toBe(0);
		expect(h.errors).toEqual([]);
		cleanup();
	});
	it('a closed transmit gate leaves wanted capture and activity inactive', async () => {
		const h = createHarness();
		const cleanup = h.mount();
		h.state.gateOpen = false;
		await h.integration.start();
		expect(h.inputs.localAudioStream?.getAudioTracks()[0]?.enabled).toBe(false);
		expect(h.monitors).toHaveLength(0);
		cleanup();
	});
});

it('retires a pending capture restart across same-channel session cleanup and rejoin', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const pending = deferred<MediaStream>();
	h.captureResults.push(pending.promise);
	const old = h.integration.restart();
	await flush();
	const lease = h.integration.createSessionLease();
	await h.integration.cleanup();
	pending.reject(new Error('retired session'));
	expect((await old).status).toBe('superseded');
	expect(lease()).toBe(false);
	expect(h.state.terminalMutes).toBe(0);
	expect(h.errors).toEqual([]);
	dispose();
});

describe('shared capture boundary', () => {
	for (const path of ['settings', 'raw loss', 'transport'] as const) {
		it(`waits for publication during ${path} despite a newer push operation`, async () => {
			const h = createHarness();
			const dispose = h.mount();
			await h.integration.start();
			const publication = deferred<Producer<AppData>>();
			h.publicationResults.push(publication.promise);
			let result: Promise<unknown> | undefined;
			if (path === 'settings') result = h.integration.restart();
			else if (path === 'transport') {
				h.newTransport();
				result = h.integration.start();
			} else {
				const track = h.integration.getRawTrack();
				track?.dispatchEvent(new Event('ended'));
				h.scheduler.advance(1000);
			}
			await flush();
			expect(h.integration.getRawTrack()?.readyState).toBe('live');
			let ensured = false;
			const controls = createOwnMicControls({
				getIntent: () => ({ micMuted: h.state.micMuted, soundMuted: false }),
				isMicWanted: () => !h.state.micMuted,
				isMicMutedWithoutTest: () => h.state.micMuted,
				setOwnVoiceIntent: () => {},
				cancelPushHold: () => {},
				commitMicFailure: () => {
					h.state.terminalMutes += 1;
				},
				getCurrentVoiceChannelId: () => h.inputs.currentVoiceChannelId,
				hasLiveMicCapture: () => h.integration.getRawTrack()?.readyState === 'live',
				captureSession: h.integration.createSessionLease,
				startMicStream: h.integration.start,
				resetMicRecoveryBudget: h.integration.resetRawRecoveryBudget,
				beginOperation: () => ++h.state.operation,
				isOperationCurrent: (token) => token === h.state.operation,
				playSound: () => {},
				showError: (message) => h.errors.push(message),
			});
			h.state.operation += 1;
			const ensure = controls.ensureMicStarted().then(() => {
				ensured = true;
			});
			await flush();
			expect(ensured).toBe(false);
			publication.resolve(createProducer('replacement'));
			await result;
			await ensure;
			expect(h.integration.getRawTrack()?.readyState).toBe('live');
			expect(h.state.terminalMutes).toBe(0);
			expect(h.errors).toEqual([]);
			dispose();
		});
	}
	for (const change of ['settings', 'volume'] as const) {
		it(`discards muted ${change} capture and rebuilds with current settings`, async () => {
			const h = createHarness();
			const dispose = h.mount();
			await h.integration.start();
			const old = h.integration.getRawTrack();
			h.state.micMuted = true;
			h.inputs.devices = { ...h.inputs.devices, microphoneId: 'new-device' };
			if (change === 'settings') await h.integration.restart();
			else {
				h.volumeChange(50);
				await flush();
			}
			expect(old?.readyState).toBe('ended');
			expect(h.integration.getRawTrack()).toBeUndefined();
			expect(h.captures).toHaveLength(1);
			h.state.micMuted = false;
			await h.integration.start();
			expect(h.captures[1]?.audio).toMatchObject({ deviceId: { exact: 'new-device' } });
			if (change === 'volume') expect(h.gains.at(-1)?.volume).toBe(50);
			dispose();
		});
	}
});

for (const join of [false, true])
	it(`rebuilds raw loss during pending ${join ? 'join' : 'start'} with gain`, async () => {
		const h = createHarness();
		const dispose = h.mount();
		h.volumeChange(70);
		h.inputs.devices = { ...h.inputs.devices, wasmNoiseSuppressionEnabled: true };
		const publication = deferred<Producer<AppData>>();
		h.publicationResults.push(publication.promise);
		const result = join ? h.integration.prepare().then((p) => h.integration.publish(p)) : h.integration.start();
		await flush();
		const raw = h.integration.getRawTrack();
		raw?.stop();
		raw?.dispatchEvent(new Event('ended'));
		publication.resolve(createProducer('dead'));
		await result;
		await flush();
		expect(h.integration.getRawTrack()?.readyState).toBe('live');
		expect(h.captures).toHaveLength(2);
		expect(h.producers.at(-1)?.closed).toBe(false);
		expect(h.inputs.localAudioStream?.getAudioTracks()[0]?.readyState).toBe('live');
		expect(h.errors).toEqual([]);
		expect(h.state.terminalMutes).toBe(0);
		dispose();
	});
for (const cleanup of [false, true])
	it(`gives current owner its own capture after retirement, cleanup=${cleanup}`, async () => {
		const h = createHarness();
		const dispose = h.mount();
		const capture = deferred<MediaStream>();
		h.captureResults.push(capture.promise);
		let current = true;
		const old = h.integration.start(() => current);
		await flush();
		current = false;
		if (cleanup) await h.integration.cleanup();
		const successor = h.integration.start();
		capture.resolve(createStream());
		expect((await old).status).toBe('superseded');
		expect((await successor).status).toBe('started');
		expect(h.integration.getRawTrack()?.readyState).toBe('live');
		expect(h.captures).toHaveLength(2);
		dispose();
	});
it('failed join after direct muted teardown cannot strand an unmute', async () => {
	const h = createHarness();
	const dispose = h.mount();
	await h.integration.prepare();
	h.state.micMuted = true;
	const raw = h.integration.getRawTrack();
	raw?.stop();
	raw?.dispatchEvent(new Event('ended'));
	await flush();
	h.state.micMuted = false;
	const result = await Promise.race([
		h.integration.start(),
		new Promise<{ status: 'timeout' }>((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 100)),
	]);
	expect(result.status).toBe('started');
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});
it('ensure after pending success does not rebuild', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const capture = deferred<MediaStream>();
	h.captureResults.push(capture.promise);
	const first = h.integration.start();
	const second = h.integration.start();
	capture.resolve(createStream());
	expect((await first).status).toBe('started');
	expect((await second).status).toBe('started');
	await h.integration.start();
	expect(h.captures).toHaveLength(1);
	dispose();
});
it('exhaustively resolves desired and actual capture states', () => {
	// Bits: wanted, present, matches, publication required, published.
	const outcomes = [
		'idle',
		'idle',
		'idle',
		'idle',
		'idle',
		'idle',
		'idle',
		'idle',
		'discard',
		'discard',
		'discard',
		'discard',
		'discard',
		'discard',
		'discard',
		'discard',
		'build',
		'build',
		'build',
		'build',
		'build',
		'build',
		'build',
		'build',
		'discard',
		'discard',
		'discard',
		'discard',
		'idle',
		'idle',
		'publish',
		'idle',
	] as const;
	for (const [bits, outcome] of outcomes.entries()) {
		expect(
			resolveCaptureAction({
				wanted: Boolean(bits & 16),
				present: Boolean(bits & 8),
				matches: Boolean(bits & 4),
				publicationRequired: Boolean(bits & 2),
				published: Boolean(bits & 1),
			}),
		).toBe(outcome);
	}
});

it('bounds repeated raw losses before one recovery has settled', async () => {
	const h = createHarness();
	const dispose = h.mount();
	h.volumeChange(70);
	const deferredPublications = Array.from({ length: 5 }, () => deferred<Producer<AppData>>());
	h.publicationResults.push(...deferredPublications.map((p) => p.promise));
	const starting = h.integration.start();
	for (const [index, publication] of deferredPublications.entries()) {
		await flush();
		const raw = h.integration.getRawTrack();
		if (!raw) break;
		raw.stop();
		raw.dispatchEvent(new Event('ended'));
		publication.resolve(createProducer(`lost-${index}`));
	}
	await starting;
	await flush();
	expect(h.state.terminalMutes).toBe(1);
	expect(h.integration.getRawTrack()).toBeUndefined();
	expect(h.captures.length).toBeLessThanOrEqual(4);
	dispose();
});
it('a fresh talk demand after exhaustion gets one deliberately reset attempt', async () => {
	const h = createHarness();
	const dispose = h.mount();
	await h.integration.start();
	for (let n = 0; n < 4; n++) {
		const raw = h.integration.getRawTrack();
		raw?.stop();
		raw?.dispatchEvent(new Event('ended'));
		await flush();
	}
	expect(h.state.terminalMutes).toBe(1);
	h.state.talkHeld = true;
	h.integration.resetRawRecoveryBudget();
	const before = h.captures.length;
	expect((await h.integration.start()).status).toBe('started');
	expect(h.captures.length).toBe(before + 1);
	const raw = h.integration.getRawTrack();
	raw?.stop();
	raw?.dispatchEvent(new Event('ended'));
	await flush();
	expect(h.state.terminalMutes).toBe(1);
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});

it('transport recovery waits for its own current capture when the previous caller retired', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const capture = deferred<MediaStream>();
	h.captureResults.push(capture.promise);
	let current = true;
	const retired = h.integration.start(() => current);
	await flush();
	current = false;
	const recovery = recoverTransportMicrophone(
		{ recoveryJoined: true, micMuted: false, canSpeak: true, hasCurrentStream: false, currentTrackLive: false },
		{
			start: () => h.integration.start(() => true),
			publishCurrent: () => h.integration.publish('current'),
			discardCurrent: h.integration.cleanup,
			onStartFailed: () => {
				throw Error('unexpected failure');
			},
		},
	);
	capture.resolve(createStream());
	expect(await recovery).toBe('started');
	expect((await retired).status).toBe('superseded');
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});

it('join publication settles a replacement after raw loss between preparation and transport readiness', async () => {
	const h = createHarness();
	const dispose = h.mount();
	h.state.transport = undefined;
	h.volumeChange(70);
	const prepared = await h.integration.prepare();
	const raw = h.integration.getRawTrack();
	raw?.stop();
	raw?.dispatchEvent(new Event('ended'));
	await flush();
	h.newTransport();
	await h.integration.publish(prepared);
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	expect(h.captures).toHaveLength(2);
	expect(h.state.terminalMutes).toBe(0);
	dispose();
});
it('volume shape changes during capture invalidate the build before publication', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const capture = deferred<MediaStream>();
	h.captureResults.push(capture.promise);
	const pending = h.integration.start();
	await flush();
	h.volumeChange(70);
	capture.resolve(createStream());
	expect((await pending).status).toBe('started');
	expect(h.gains.at(-1)?.volume).toBe(70);
	expect(h.captures).toHaveLength(2);
	dispose();
});

for (const retirement of ['same-channel cleanup', 'deactivate/reactivate'] as const) {
	it(`a retired start cannot hide successor join preparation after ${retirement}`, async () => {
		const h = createHarness();
		const dispose = h.mount();
		try {
			const oldCapture = deferred<MediaStream>();
			h.captureResults.push(oldCapture.promise);
			const old = h.integration.start();
			await flush();
			if (retirement === 'same-channel cleanup') await h.integration.cleanup();
			else {
				await h.integration.deactivate();
				h.integration.activate();
			}
			h.state.transport = undefined;
			const newCapture = deferred<MediaStream>();
			h.captureResults.push(newCapture.promise);
			const joinPrepared = h.integration.prepare().then(
				(prepared) => ({ prepared }),
				(error: unknown) => ({ error }),
			);
			await flush();
			const controls = createOwnMicControls({
				getIntent: () => ({ micMuted: h.state.micMuted, soundMuted: false }),
				isMicWanted: () => !h.state.micMuted,
				isMicMutedWithoutTest: () => h.state.micMuted,
				setOwnVoiceIntent: (intent) => {
					if (intent.micMuted !== undefined) h.state.micMuted = intent.micMuted;
				},
				cancelPushHold: () => {},
				commitMicFailure: h.integration.commitTerminalMute,
				getCurrentVoiceChannelId: () => h.inputs.currentVoiceChannelId,
				hasLiveMicCapture: () => h.integration.getRawTrack()?.readyState === 'live',
				captureSession: h.integration.createSessionLease,
				startMicStream: h.integration.start,
				resetMicRecoveryBudget: h.integration.resetRawRecoveryBudget,
				beginOperation: () => ++h.state.operation,
				isOperationCurrent: (token) => token === h.state.operation,
				playSound: () => {},
				showError: (error) => h.errors.push(error),
			});
			let ensured = false;
			const ensure = controls.ensureMicStarted().then(() => {
				ensured = true;
			});
			oldCapture.resolve(createStream('retired'));
			await old;
			await flush();
			await flush();
			await flush();
			const ensuredBeforeJoin = ensured;
			const capturesBeforeJoin = h.captures.length;
			h.newTransport();
			const successor = createStream('new-session');
			newCapture.resolve(successor);
			const result = await joinPrepared;
			if ('prepared' in result) await h.integration.publish(result.prepared);
			await ensure;
			expect(ensuredBeforeJoin).toBe(false);
			expect(capturesBeforeJoin).toBe(2);
			expect(h.captures).toHaveLength(2);
			expect('prepared' in result).toBe(true);
			expect(h.integration.getRawTrack()).toBe(successor.track);
			expect(successor.track.readyState).toBe('live');
			expect(h.producers.at(-1)?.closed).toBe(false);
			expect(h.state.micMuted).toBe(false);
			expect(h.state.terminalMutes).toBe(0);
			expect(h.errors).toEqual([]);
		} finally {
			dispose();
		}
	});
}

it('a stale prepare cannot retire or strand a live successor', async () => {
	const h = createHarness();
	const dispose = h.mount();
	await h.integration.start();
	const track = h.integration.getRawTrack();
	await expect(h.integration.prepare(() => false)).rejects.toBeInstanceOf(MicPipelineSupersededError);
	h.integration.syncInputs();
	expect((await h.integration.start()).status).toBe('started');
	expect(h.integration.getRawTrack()).toBe(track);
	expect(h.captures).toHaveLength(1);
	dispose();
});

it('re-evaluates current waiters when their earlier owner retires after they requested capture', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const capture = deferred<MediaStream>();
	h.captureResults.push(capture.promise);
	let current = true;
	const old = h.integration.start(() => current);
	await flush();
	const successor = h.integration.start(() => true);
	current = false;
	capture.resolve(createStream());
	expect((await old).status).toBe('superseded');
	expect((await successor).status).toBe('started');
	expect(h.captures).toHaveLength(2);
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});

it('restore captures for its requested channel before UI publication and survives attempt completion', async () => {
	const h = createHarness();
	const dispose = h.mount();
	h.inputs.currentVoiceChannelId = undefined;
	let current = true;
	const prepared = await h.integration.prepare(() => current, 1);
	await h.integration.publish(prepared, () => current);
	h.inputs.currentVoiceChannelId = 1;
	current = false;
	h.integration.syncInputs();
	expect((await h.integration.start()).status).toBe('started');
	expect(h.captures).toHaveLength(1);
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});

it('recovers a capture already ended before its loss listener could be attached', async () => {
	const h = createHarness();
	const dispose = h.mount();
	const ended = createStream();
	ended.track.stop();
	h.captureResults.push(Promise.resolve(ended));
	expect((await h.integration.start()).status).toBe('started');
	expect(h.captures).toHaveLength(2);
	expect(h.integration.getRawTrack()?.readyState).toBe('live');
	dispose();
});
