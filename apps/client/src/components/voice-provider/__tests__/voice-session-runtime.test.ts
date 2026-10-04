import { afterEach, describe, expect, it, mock } from 'bun:test';
import { StreamKind, type TVoiceUserState } from '@sharkord/shared';
import type { Device, RtpCapabilities } from 'mediasoup-client/types';
import type {
	TVoiceSessionRebuildContext,
	TVoiceSessionRestoreContext,
} from '@/features/server/voice/voice-session-command-executor';
import type {
	TVoiceSessionCommand,
	TWatchedRemoteStreamsSnapshot,
} from '@/features/server/voice/voice-session-machine';
import {
	dispatchVoiceSession,
	dispatchVoiceSessionWithResult,
	getVoiceSessionState,
	resetVoiceSessionState,
} from '@/features/server/voice/voice-session-store';
import { VoiceSessionExecutionSupersededError } from '../hooks/session-execution-ownership';
import type { TMicrophonePreparedPipeline } from '../microphone-pipeline-controller';
import {
	createVoiceSessionRuntime,
	mountVoiceSessionRuntime,
	type TVoiceSessionRuntimeDependencies,
} from '../voice-session-runtime';

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
};
const flush = async () => {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};
const capabilities: RtpCapabilities = { codecs: [] };
const snapshot: TWatchedRemoteStreamsSnapshot = {
	remoteUserStreams: { 20: [StreamKind.SCREEN, StreamKind.SCREEN_AUDIO] },
	externalStreams: { 30: { audio: true, video: true } },
};
const rebuildCommand: Extract<TVoiceSessionCommand, { type: 'RebuildTransports' }> = {
	type: 'RebuildTransports',
	commandId: 2,
	generation: 2,
	channelId: 5,
	nonce: 1,
	attempt: 0,
	snapshot,
};
const restoreCommand: Extract<TVoiceSessionCommand, { type: 'RestoreVoiceSession' }> = {
	type: 'RestoreVoiceSession',
	commandId: 3,
	generation: 3,
	attempt: 0,
	snapshot,
	pending: { channelId: 5, micMuted: false, soundMuted: false, peerUserIds: [20], expiresAt: 60_000 },
};
const clearCommand: Extract<TVoiceSessionCommand, { type: 'ClearFailedSession' }> = {
	type: 'ClearFailedSession',
	commandId: 4,
	generation: 3,
	channelId: 5,
	reason: 'restore-terminal-error',
	leaveServerSession: true,
};
const createDevice = (load: () => Promise<void> = async () => {}) => {
	// Only device loading and capabilities are used by the runtime. Real transport
	// creation stays behind useTransports; these partial media mocks acquire nothing.
	const partialDevice = { load: mock(load), rtpCapabilities: capabilities };
	return { ...partialDevice, device: partialDevice as unknown as Device };
};
const createPreparedMicrophone = (): TMicrophonePreparedPipeline => ({
	outboundStream: {} as MediaStream,
	outboundAudioTrack: { readyState: 'live' } as MediaStreamTrack,
});

const createHarness = () => {
	const state: {
		channelId: number | undefined;
		connected: boolean;
		nonce: number;
		canSpeak: boolean;
		own: TVoiceUserState;
		currentPrepared: TMicrophonePreparedPipeline | undefined;
		microphoneActive: boolean;
	} = {
		channelId: 5,
		connected: true,
		nonce: 1,
		canSpeak: true,
		own: { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false },
		currentPrepared: undefined,
		microphoneActive: true,
	};
	const device = createDevice();
	const bootstrap: Awaited<ReturnType<TVoiceSessionRuntimeDependencies['requestVoiceRestoreOrJoin']>> = {
		routerRtpCapabilities: capabilities,
		channelUsers: [],
		existingProducers: {
			remoteVideoIds: [],
			remoteAudioIds: [],
			remoteScreenIds: [],
			remoteScreenAudioIds: [],
			remoteExternalStreamIds: [],
		},
	};
	const server = {
		get connected() {
			return state.connected;
		},
		setCurrentVoiceChannelId: mock((id: number | undefined) => {
			state.channelId = id;
		}),
		updateOwnVoiceState: mock(() => {}),
		setPinnedCard: mock(() => {}),
		reconcileVoiceChannelUsers: mock(() => {}),
		bumpVoiceSessionReconnectNonce: mock(() => {}),
	};
	const microphone = {
		createLifecycleLease: () => ({ isCurrent: () => state.microphoneActive }),
		prepare: mock(async (_isCurrent?: () => boolean): Promise<TMicrophonePreparedPipeline> => {
			const prepared = createPreparedMicrophone();
			state.currentPrepared = prepared;
			return prepared;
		}),
		publish: mock(async (_source: TMicrophonePreparedPipeline | 'current', _isCurrent?: () => boolean) => {}),
		start: mock(async () => ({ status: 'started' as const })),
		cleanup: mock(async () => {
			state.currentPrepared = undefined;
		}),
		owns: (prepared: TMicrophonePreparedPipeline) => state.currentPrepared === prepared,
	};
	const webcam = {
		stop: mock(() => {}),
		detachProducer: mock(() => {}),
		republish: mock((_isCurrent?: () => boolean): Promise<void> | undefined => undefined),
	};
	const screenShare = {
		stop: mock(() => {}),
		detachProducer: mock(() => {}),
		republish: mock((_isCurrent?: () => boolean): Promise<void> | undefined => undefined),
	};
	const shareAudio = {
		detachProducer: mock(() => {}),
		hasDesktopIntent: () => false,
		republish: mock((_isCurrent?: () => boolean): Promise<void> | undefined => undefined),
		recover: mock(async () => {}),
	};
	const ports = {
		microphone,
		webcam,
		screenShare,
		shareAudio,
		getChannelId: () => state.channelId,
		isConnected: () => state.connected,
		getReconnectNonce: () => state.nonce,
		canSpeak: () => state.canSpeak,
		getLocalAudioStream: (): MediaStream | undefined => undefined,
		getProducerTransport: () => undefined,
		getConsumerTransport: () => undefined,
		getOwnVoiceState: () => state.own,
		getServerState: () => server,
		createDevice: mock(async () => device.device),
		requestVoiceRestoreOrJoin: mock(async () => bootstrap),
		sendOwnVoiceStateUpdate: mock(async () => {}),
		updateOwnVoiceState: mock(() => {}),
		clearOwnVoiceSessionAfterReconnectFailure: mock(() => {}),
		leaveVoiceSessionAfterRecoveryFailure: mock(async () => true),
		notifyConnectionLost: mock(() => {}),
		commitTerminalMicMuted: mock(() => {}),
		clearRemoteUserStreams: mock(() => {}),
		clearExternalStreams: mock(() => {}),
		clearMediaElementRefs: mock(() => {}),
		clearActivity: mock(() => {}),
		publishRtpCapabilities: mock((_caps: RtpCapabilities | null) => {}),
		rehydrateWatchIntentOnly: mock((_snapshot: TWatchedRemoteStreamsSnapshot) => {}),
		captureWatchedRemoteStreams: () => snapshot,
		dispatchVoiceSession,
		dispatchVoiceSessionWithResult,
		getVoiceSessionState,
		logVoice: () => {},
		logDebug: () => {},
		traceSentrySpan: <T>(_context: unknown, effect: () => Promise<T>) => effect(),
		now: () => 1000,
		createReconnectAttemptId: () => 'attempt-1',
		getErrorCode: (error: unknown) => (error === missingSession ? 'BAD_REQUEST' : undefined),
		withRecoveryTimeout: <T>(operation: Promise<T>) => operation,
		waitForProducerRefresh: mock(async () => {}),
		createProducerTransport: mock(async (_device: Device, _params?: unknown, _current?: () => boolean) => {}),
		createConsumerTransport: mock(async (_device: Device, _params?: unknown, _current?: () => boolean) => {}),
		consumeExistingProducers: mock(async (_caps: RtpCapabilities, _tracks?: unknown, _producers?: unknown) => {}),
		cleanupTransports: mock((_options?: { preserveRemoteMediaIntent?: boolean }) => {}),
		startMonitoring: mock(() => {}),
		stopMonitoring: mock(() => {}),
		resetStats: mock(() => {}),
	} satisfies TVoiceSessionRuntimeDependencies;
	const runtime = createVoiceSessionRuntime(() => ports);
	const unmount = mountVoiceSessionRuntime(runtime);
	const contextState = { current: true };
	const rebuildContext: TVoiceSessionRebuildContext = {
		signal: new AbortController().signal,
		isCurrent: () => contextState.current,
		restartIfNonceChanged: (nonce) => !contextState.current || nonce !== rebuildCommand.nonce,
	};
	const markServerSessionEstablished = mock(() => {});
	const restoreContext: TVoiceSessionRestoreContext = {
		signal: new AbortController().signal,
		isCurrent: () => contextState.current,
		withTimeout: <T>(operation: Promise<T>) => operation,
		markServerSessionEstablished,
	};
	return {
		runtime,
		unmount,
		ports,
		state,
		device,
		bootstrap,
		server,
		contextState,
		rebuildContext,
		restoreContext,
		markServerSessionEstablished,
	};
};
const missingSession = new Error('missing server seat');
afterEach(() => resetVoiceSessionState());

describe('voice session runtime effects', () => {
	it('constructs and activates without media acquisition or signaling', () => {
		const h = createHarness();
		expect(h.ports.createDevice).not.toHaveBeenCalled();
		expect(h.ports.microphone.prepare).not.toHaveBeenCalled();
		expect(h.ports.requestVoiceRestoreOrJoin).not.toHaveBeenCalled();
		h.unmount();
	});

	it('prepares the microphone while device loading and both transports are pending', async () => {
		const h = createHarness();
		const load = deferred<void>();
		const producer = deferred<void>();
		const consumer = deferred<void>();
		h.device.load.mockImplementation(() => load.promise);
		h.ports.createProducerTransport.mockImplementation(() => producer.promise);
		h.ports.createConsumerTransport.mockImplementation(() => consumer.promise);
		const init = h.runtime.init(capabilities, 5);
		await flush();
		expect(h.ports.microphone.prepare).toHaveBeenCalledTimes(1);
		expect(h.ports.createProducerTransport).not.toHaveBeenCalled();
		load.resolve();
		await flush();
		expect(h.ports.createProducerTransport).toHaveBeenCalledTimes(1);
		expect(h.ports.createConsumerTransport).toHaveBeenCalledTimes(1);
		expect(h.ports.microphone.publish).not.toHaveBeenCalled();
		producer.resolve();
		consumer.resolve();
		await init;
		expect(h.ports.microphone.publish).toHaveBeenCalledTimes(1);
		expect(getVoiceSessionState().phase.phase).toBe('connected');
	});

	it.each([
		'terminal',
		'recovery',
		'deactivate',
	] as const)('fences deferred init loading after %s cleanup', async (kind) => {
		const h = createHarness();
		const load = deferred<void>();
		h.device.load.mockImplementation(() => load.promise);
		const result = h.runtime.init(capabilities, 5).catch((error: unknown) => error);
		await flush();
		if (kind === 'terminal') h.runtime.terminalCleanup();
		else if (kind === 'recovery') h.runtime.recoveryCleanup();
		else h.unmount();
		load.resolve();
		expect(await result).toBeInstanceOf(VoiceSessionExecutionSupersededError);
		expect(h.runtime.getRtpCapabilities()).toBeNull();
		expect(h.ports.createProducerTransport).not.toHaveBeenCalled();
		expect(h.ports.startMonitoring).not.toHaveBeenCalled();
	});

	it('does not let an old init failure destroy a successor microphone', async () => {
		const h = createHarness();
		const oldLoad = deferred<void>();
		h.ports.createDevice.mockImplementationOnce(async () => createDevice(() => oldLoad.promise).device);
		const oldInit = h.runtime.init(capabilities, 5).catch((error: unknown) => error);
		await flush();
		await h.runtime.init(capabilities, 5);
		const successor = h.state.currentPrepared;
		const cleanupCount = h.ports.microphone.cleanup.mock.calls.length;
		oldLoad.reject(new Error('old device failed'));
		expect(await oldInit).toBeInstanceOf(Error);
		expect(h.state.currentPrepared).toBe(successor);
		expect(h.ports.microphone.cleanup).toHaveBeenCalledTimes(cleanupCount);
		expect(getVoiceSessionState().phase.phase).toBe('connected');
	});

	it('cleans its own prepared microphone on current init failure', async () => {
		const h = createHarness();
		h.ports.createProducerTransport.mockRejectedValueOnce(new Error('transport failed'));
		await expect(h.runtime.init(capabilities, 5)).rejects.toThrow('transport failed');
		expect(h.state.currentPrepared).toBeUndefined();
		expect(getVoiceSessionState().phase.phase).toBe('failed');
	});

	it('continues a fresh join when microphone preparation fails', async () => {
		const h = createHarness();
		h.ports.microphone.prepare.mockRejectedValueOnce(new Error('permission denied'));
		await h.runtime.init(capabilities, 5);
		expect(h.ports.microphone.publish).not.toHaveBeenCalled();
		expect(h.ports.startMonitoring).toHaveBeenCalledTimes(1);
	});

	it('terminal cleanup stops local owners while recovery detaches and preserves watch intent', () => {
		const h = createHarness();
		h.runtime.recoveryCleanup();
		expect(h.ports.webcam.detachProducer).toHaveBeenCalledTimes(1);
		expect(h.ports.screenShare.detachProducer).toHaveBeenCalledTimes(1);
		expect(h.ports.shareAudio.detachProducer).toHaveBeenCalledTimes(1);
		expect(h.ports.webcam.stop).not.toHaveBeenCalled();
		expect(h.ports.screenShare.stop).not.toHaveBeenCalled();
		expect(h.ports.cleanupTransports).toHaveBeenLastCalledWith({ preserveRemoteMediaIntent: true });
		// Microphone reacquisition on WS restore remains separate from video capture.
		expect(h.ports.microphone.cleanup).toHaveBeenCalledTimes(1);
		h.runtime.terminalCleanup();
		expect(h.ports.webcam.stop).toHaveBeenCalledTimes(1);
		expect(h.ports.screenShare.stop).toHaveBeenCalledTimes(1);
		expect(h.ports.cleanupTransports).toHaveBeenLastCalledWith({ preserveRemoteMediaIntent: false });
	});

	it('retains capture and watch intent after preserved-media republishing fails', async () => {
		const h = createHarness();
		h.ports.screenShare.republish.mockImplementation(() => Promise.reject(new Error('publication failed')));
		await expect(
			h.runtime.init(capabilities, 5, { preserveLocalMedia: true, restoreWatchSnapshot: snapshot }),
		).rejects.toThrow('publication failed');
		expect(h.ports.webcam.stop).not.toHaveBeenCalled();
		expect(h.ports.screenShare.stop).not.toHaveBeenCalled();
		expect(h.ports.rehydrateWatchIntentOnly).toHaveBeenCalledWith(snapshot);
	});

	it('restores prefetched producers and synchronizes republished local media after success', async () => {
		const h = createHarness();
		h.ports.webcam.republish.mockImplementation(() => Promise.resolve());
		h.ports.screenShare.republish.mockImplementation(() => Promise.resolve());
		h.ports.shareAudio.republish.mockImplementation(() => Promise.resolve());
		await h.runtime.restoreVoiceSession(restoreCommand, h.restoreContext);
		expect(h.markServerSessionEstablished).toHaveBeenCalledTimes(1);
		expect(h.ports.consumeExistingProducers).toHaveBeenCalledWith(
			capabilities,
			undefined,
			h.bootstrap.existingProducers,
		);
		expect(h.ports.rehydrateWatchIntentOnly).toHaveBeenCalledWith(snapshot);
		expect(h.server.reconcileVoiceChannelUsers).toHaveBeenCalledWith({ channelId: 5, users: h.bootstrap.channelUsers });
		expect(h.ports.updateOwnVoiceState).toHaveBeenCalledWith({ webcamEnabled: true, sharingScreen: true });
	});

	it('records server establishment before rejecting a superseded restore RPC', async () => {
		const h = createHarness();
		const request = deferred<typeof h.bootstrap>();
		h.ports.requestVoiceRestoreOrJoin.mockImplementation(() => request.promise);
		const result = h.runtime.restoreVoiceSession(restoreCommand, h.restoreContext).catch((error: unknown) => error);
		h.contextState.current = false;
		request.resolve(h.bootstrap);
		expect(await result).toBeInstanceOf(VoiceSessionExecutionSupersededError);
		expect(h.markServerSessionEstablished).toHaveBeenCalledTimes(1);
		expect(h.ports.createDevice).not.toHaveBeenCalled();
		expect(h.server.reconcileVoiceChannelUsers).not.toHaveBeenCalled();
	});

	it('retains established-session tracking when initialization fails', async () => {
		const h = createHarness();
		h.device.load.mockRejectedValueOnce(new Error('device failed'));
		await expect(h.runtime.restoreVoiceSession(restoreCommand, h.restoreContext)).rejects.toThrow('device failed');
		expect(h.markServerSessionEstablished).toHaveBeenCalledTimes(1);
		expect(h.ports.leaveVoiceSessionAfterRecoveryFailure).not.toHaveBeenCalled();
	});

	it('does not publish local media state after a superseded server update', async () => {
		const h = createHarness();
		const update = deferred<void>();
		h.ports.webcam.republish.mockImplementation(() => Promise.resolve());
		h.ports.sendOwnVoiceStateUpdate.mockImplementation(() => update.promise);
		const result = h.runtime.restoreVoiceSession(restoreCommand, h.restoreContext).catch((error: unknown) => error);
		await flush();
		expect(h.ports.sendOwnVoiceStateUpdate).toHaveBeenCalledTimes(1);
		h.contextState.current = false;
		update.resolve();
		expect(await result).toBeInstanceOf(VoiceSessionExecutionSupersededError);
		expect(h.ports.updateOwnVoiceState).not.toHaveBeenCalled();
	});

	it('disconnected rebuild does not clear resources or consume watch intent', async () => {
		const h = createHarness();
		await h.runtime.init(capabilities, 5);
		h.state.connected = false;
		const cleanupCount = h.ports.cleanupTransports.mock.calls.length;
		await expect(h.runtime.rebuildTransports(rebuildCommand, h.rebuildContext)).rejects.toThrow(
			'server connection unavailable',
		);
		expect(h.ports.cleanupTransports).toHaveBeenCalledTimes(cleanupCount);
		expect(h.ports.rehydrateWatchIntentOnly).not.toHaveBeenCalled();
	});

	it('rebuild retains the live microphone and restores remote producer subscriptions', async () => {
		const h = createHarness();
		await h.runtime.init(capabilities, 5);
		h.ports.getLocalAudioStream = () => ({ getAudioTracks: () => [{ readyState: 'live' }] }) as MediaStream;
		const cleanupCount = h.ports.microphone.cleanup.mock.calls.length;
		await h.runtime.rebuildTransports(rebuildCommand, h.rebuildContext);
		expect(h.ports.microphone.publish).toHaveBeenLastCalledWith('current', expect.any(Function));
		expect(h.ports.microphone.cleanup).toHaveBeenCalledTimes(cleanupCount);
		expect(h.ports.consumeExistingProducers).toHaveBeenCalledTimes(2);
		expect(h.ports.rehydrateWatchIntentOnly).toHaveBeenCalledWith(snapshot);
	});

	it('rejoins a missing server session and refreshes producers immediately and after the existing delay', async () => {
		const h = createHarness();
		await h.runtime.init(capabilities, 5);
		h.state.own.micMuted = true;
		h.ports.createProducerTransport.mockRejectedValueOnce(missingSession);
		await h.runtime.rebuildTransports(rebuildCommand, h.rebuildContext);
		expect(h.ports.requestVoiceRestoreOrJoin).toHaveBeenCalledTimes(1);
		expect(h.ports.microphone.start).not.toHaveBeenCalled();
		expect(h.ports.consumeExistingProducers).toHaveBeenCalledTimes(4);
		expect(h.ports.waitForProducerRefresh).toHaveBeenCalledTimes(1);
		expect(h.server.bumpVoiceSessionReconnectNonce).toHaveBeenCalledTimes(1);
	});

	it('stops rebuild publication after the executor supersedes pending transport creation', async () => {
		const h = createHarness();
		await h.runtime.init(capabilities, 5);
		const transport = deferred<void>();
		h.ports.createProducerTransport.mockImplementation(() => transport.promise);
		const rebuild = h.runtime.rebuildTransports(rebuildCommand, h.rebuildContext);
		await flush();
		h.contextState.current = false;
		transport.resolve();
		await rebuild;
		expect(h.ports.consumeExistingProducers).toHaveBeenCalledTimes(1);
		expect(h.ports.startMonitoring).toHaveBeenCalledTimes(1);
	});

	it('leaves an established server seat but cleans locally before leave completes', async () => {
		const h = createHarness();
		const leave = deferred<boolean>();
		h.ports.leaveVoiceSessionAfterRecoveryFailure.mockImplementation(() => leave.promise);
		const cleanup = h.runtime.clearFailedSession(clearCommand);
		expect(h.ports.clearOwnVoiceSessionAfterReconnectFailure).toHaveBeenCalledTimes(1);
		expect(h.ports.screenShare.stop).toHaveBeenCalledTimes(1);
		leave.resolve(true);
		await cleanup;
	});

	it('an old terminal leave completion cannot clean up a later init', async () => {
		const h = createHarness();
		const leave = deferred<boolean>();
		h.ports.leaveVoiceSessionAfterRecoveryFailure.mockImplementation(() => leave.promise);
		const cleanup = h.runtime.clearFailedSession(clearCommand);
		await h.runtime.init(capabilities, 5);
		const successor = h.state.currentPrepared;
		const stopCount = h.ports.screenShare.stop.mock.calls.length;
		leave.resolve(true);
		await cleanup;
		expect(h.state.currentPrepared).toBe(successor);
		expect(h.ports.screenShare.stop).toHaveBeenCalledTimes(stopCount);
	});

	it('offline terminal cleanup skips server leave and relies on disconnect grace', async () => {
		const h = createHarness();
		h.state.connected = false;
		await h.runtime.clearFailedSession(clearCommand);
		expect(h.ports.leaveVoiceSessionAfterRecoveryFailure).not.toHaveBeenCalled();
		expect(h.ports.screenShare.stop).toHaveBeenCalledTimes(1);
	});

	it('only accepted connected failures latch transport recovery', () => {
		const h = createHarness();
		dispatchVoiceSession({ type: 'JoinSucceeded', channelId: 5 });
		h.state.connected = false;
		h.runtime.onTransportFailure();
		expect(getVoiceSessionState().phase.phase).toBe('connected');
		h.state.connected = true;
		h.runtime.onTransportFailure();
		expect(getVoiceSessionState().phase.phase).toBe('rebuilding');
		const phase = getVoiceSessionState().phase;
		h.runtime.onTransportFailure();
		expect(getVoiceSessionState().phase).toEqual(phase);
	});

	it('old failure callbacks cannot start recovery after runtime replacement', () => {
		const old = createHarness();
		const callback = old.runtime.onTransportFailure;
		old.unmount();
		old.unmount();
		const successor = createHarness();
		dispatchVoiceSession({ type: 'JoinSucceeded', channelId: 5 });
		callback();
		expect(getVoiceSessionState().phase.phase).toBe('connected');
		successor.runtime.onTransportFailure();
		expect(getVoiceSessionState().phase.phase).toBe('rebuilding');
	});

	it('reactivates a retained runtime after Strict Mode lifecycle replay', async () => {
		const h = createHarness();
		h.unmount();
		const cleanup = mountVoiceSessionRuntime(h.runtime);
		await h.runtime.init(capabilities, 5);
		expect(h.ports.startMonitoring).toHaveBeenCalledTimes(1);
		cleanup();
	});
});
