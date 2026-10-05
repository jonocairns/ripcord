import { describe, expect, it, mock } from 'bun:test';
import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import {
	clearRemoteMediaForExternalStream,
	clearRemoteMediaProducerStateForTransportCleanup,
	markRemoteConsumeStarted,
	markRemoteProducerPresent,
	markRemoteRetryRequested,
	markRemoteWatchRequested,
	markRemoteWatchStopped,
	reconcileRemoteMediaWithProducerSnapshot,
	rehydrateRemoteMediaWatchIntentOnly,
	remoteMediaSubscriptionsToPendingStreams,
	type TRemoteMediaReducerResult,
} from '../hooks/remote-media-subscriptions';
import { getPendingStreamKey } from '../hooks/use-pending-streams';
import {
	createRemoteMediaIntegration,
	mountRemoteMediaIntegration,
	type TRemoteMediaIntegrationInputs,
} from '../remote-media-integration';

const fixture = (activate = true) => {
	const commit = (result: TRemoteMediaReducerResult) => {
		inputs.remoteMediaSubscriptions = result.state;
		inputs.pendingStreams = remoteMediaSubscriptionsToPendingStreams(result.state);
		return result.commands;
	};
	const inputs: TRemoteMediaIntegrationInputs = {
		currentVoiceChannelId: 5,
		remoteMediaSubscriptions: new Map(),
		pendingStreams: new Map(),
		currentChannelExternalStreams: {},
		externalStreams: {},
		getRtpCapabilities: () => ({}),
		markConsumeStarted: (id, kind, producer, generation, manual) => {
			commit(markRemoteConsumeStarted(inputs.remoteMediaSubscriptions, id, kind, 1, producer, generation, manual));
		},
		markWatchRequested: (id, kind, tracks) => {
			commit(markRemoteWatchRequested(inputs.remoteMediaSubscriptions, id, kind, 1, { externalStreamTracks: tracks }));
		},
		markRetryRequested: (id, kind, tracks) => {
			commit(markRemoteRetryRequested(inputs.remoteMediaSubscriptions, id, kind, 1, { externalStreamTracks: tracks }));
		},
		addPendingStream: (id, kind, producer, tracks) => {
			commit(
				markRemoteProducerPresent(inputs.remoteMediaSubscriptions, id, kind, 1, producer, {
					externalStreamTracks: tracks,
				}),
			);
		},
		clearRemoteMediaExternalStream: (id) => {
			inputs.remoteMediaSubscriptions = clearRemoteMediaForExternalStream(inputs.remoteMediaSubscriptions, id);
		},
		removeExternalStream: mock((_id: number) => {}),
		log: mock(() => {}),
	};
	const integration = createRemoteMediaIntegration(() => inputs);
	const unmount = activate ? mountRemoteMediaIntegration(integration) : () => {};
	return { inputs, integration, commit, unmount };
};

describe('remote media composition integration', () => {
	it('refuses inactive and already aborted consume publication without changing the ledger', async () => {
		const f = fixture(false);
		const abort = new AbortController();
		expect(
			await f.integration.publishRemoteMediaConsumeStarted(7, StreamKind.AUDIO, 'mic', 1, false, abort.signal),
		).toBe(false);
		const unmount = mountRemoteMediaIntegration(f.integration);
		abort.abort();
		expect(
			await f.integration.publishRemoteMediaConsumeStarted(7, StreamKind.AUDIO, 'mic', 2, false, abort.signal),
		).toBe(false);
		expect(f.inputs.remoteMediaSubscriptions.size).toBe(0);
		unmount();
	});
	it('settles pending publication on layout cleanup while preserving ledger and stream ownership', async () => {
		const f = fixture();
		const pending = f.integration.publishRemoteMediaConsumeStarted(
			7,
			StreamKind.AUDIO,
			'mic',
			1,
			false,
			new AbortController().signal,
		);
		const subscriptions = f.inputs.remoteMediaSubscriptions;
		f.unmount();
		expect(await pending).toBe(false);
		expect(f.inputs.remoteMediaSubscriptions).toBe(subscriptions);
		expect(f.inputs.removeExternalStream).not.toHaveBeenCalled();
	});
	it('replays activation with fresh publication and rejects the old completion after acknowledgement', async () => {
		const f = fixture();
		const old = f.integration.publishRemoteMediaConsumeStarted(
			7,
			StreamKind.AUDIO,
			'mic',
			1,
			false,
			new AbortController().signal,
		);
		f.integration.reconcileConsumeStarts();
		f.unmount();
		const replayCleanup = mountRemoteMediaIntegration(f.integration);
		const replay = f.integration.publishRemoteMediaConsumeStarted(
			7,
			StreamKind.AUDIO,
			'mic',
			2,
			false,
			new AbortController().signal,
		);
		f.unmount();
		f.integration.reconcileConsumeStarts();
		expect(await old).toBe(false);
		expect(await replay).toBe(true);
		replayCleanup();
	});
	it('replacing an activation cancels only its pending acknowledgement and makes old cleanup inert', async () => {
		const f = fixture();
		const old = f.integration.publishRemoteMediaConsumeStarted(
			7,
			StreamKind.AUDIO,
			'mic',
			1,
			false,
			new AbortController().signal,
		);
		const replacementCleanup = mountRemoteMediaIntegration(f.integration);
		expect(await old).toBe(false);
		f.unmount();
		const replacement = f.integration.publishRemoteMediaConsumeStarted(
			7,
			StreamKind.AUDIO,
			'mic',
			2,
			false,
			new AbortController().signal,
		);
		f.integration.reconcileConsumeStarts();
		expect(await replacement).toBe(true);
		replacementCleanup();
	});
	it('old provider cleanup cannot dispose a replacement provider acknowledgement', async () => {
		const old = fixture();
		const replacement = fixture();
		const pending = replacement.integration.publishRemoteMediaConsumeStarted(
			7,
			StreamKind.AUDIO,
			'mic',
			1,
			false,
			new AbortController().signal,
		);
		old.unmount();
		replacement.integration.reconcileConsumeStarts();
		expect(await pending).toBe(true);
		replacement.unmount();
	});
	it('ignores stale mutation callbacks and rejects producer/repair currency after cleanup', () => {
		const f = fixture();
		f.inputs.addPendingStream(7, StreamKind.SCREEN, 'screen');
		f.integration.acceptStream(7, StreamKind.SCREEN);
		const subscriptions = f.inputs.remoteMediaSubscriptions;
		f.unmount();
		f.integration.acceptStream(8, StreamKind.VIDEO);
		f.integration.retryRemoteMedia(7, StreamKind.SCREEN);
		f.integration.removeExternalStreamAndSubscription(99);
		f.integration.reconcileExternalStreams();
		expect(f.inputs.remoteMediaSubscriptions).toBe(subscriptions);
		expect(f.inputs.removeExternalStream).not.toHaveBeenCalled();
		expect(f.integration.isRemoteMediaProducerCurrent(7, StreamKind.SCREEN, 'screen')).toBe(false);
		expect(
			f.integration.isRemoteMediaRepairIdentityCurrent({
				channelId: 5,
				key: getPendingStreamKey(7, StreamKind.SCREEN),
				remoteId: 7,
				kind: StreamKind.SCREEN,
				producerId: 'screen',
			}),
		).toBe(false);
	});
	it('seeds only declared missing external tracks and keeps stopped pending intent unchanged', () => {
		const f = fixture();
		f.inputs.currentChannelExternalStreams = {
			99: { title: 'External', key: 'stream', pluginId: 'plugin', tracks: { audio: true, video: false } },
		};
		f.integration.reconcileExternalStreams();
		expect(f.inputs.remoteMediaSubscriptions.has(getPendingStreamKey(99, StreamKind.EXTERNAL_VIDEO))).toBe(false);
		f.integration.acceptStream(99, StreamKind.EXTERNAL_AUDIO);
		f.commit(markRemoteWatchStopped(f.inputs.remoteMediaSubscriptions, 99, StreamKind.EXTERNAL_AUDIO, 2));
		const stopped = f.inputs.remoteMediaSubscriptions;
		f.integration.reconcileExternalStreams();
		expect(f.inputs.remoteMediaSubscriptions).toBe(stopped);
		expect(f.integration.captureWatchedRemoteStreams().externalStreams).toEqual({});
	});
	it('does not seed an already attached external track', () => {
		const f = fixture();
		f.inputs.currentChannelExternalStreams = {
			99: { title: 'External', key: 'stream', pluginId: 'plugin', tracks: { video: true } },
		};
		f.inputs.externalStreams = { 99: { videoStream: {} as MediaStream } };
		f.integration.reconcileExternalStreams();
		expect(f.inputs.remoteMediaSubscriptions.size).toBe(0);
	});
	it('constructs without publishing ledger state or touching stream resources', () => {
		const f = fixture(false);
		expect(f.inputs.remoteMediaSubscriptions.size).toBe(0);
		expect(f.inputs.removeExternalStream).not.toHaveBeenCalled();
	});
	it('acknowledges consume only after the authoritative ledger is committed', async () => {
		const f = fixture();
		let acknowledged = false;
		const result = f.integration.publishRemoteMediaConsumeStarted(
			7,
			StreamKind.AUDIO,
			'mic',
			10,
			false,
			new AbortController().signal,
		);
		void result.then(() => {
			acknowledged = true;
		});
		await Promise.resolve();
		expect(acknowledged).toBe(false);
		f.integration.reconcileConsumeStarts();
		expect(await result).toBe(true);
	});
	it('rejects producer replacement during consume publication and reads the replacement identity', async () => {
		const f = fixture();
		const result = f.integration.publishRemoteMediaConsumeStarted(
			7,
			StreamKind.VIDEO,
			'old',
			10,
			false,
			new AbortController().signal,
		);
		f.inputs.addPendingStream(7, StreamKind.VIDEO, 'new');
		f.integration.reconcileConsumeStarts();
		expect(await result).toBe(false);
		expect(f.integration.isRemoteMediaProducerCurrent(7, StreamKind.VIDEO, 'old')).toBe(false);
		expect(f.integration.isRemoteMediaProducerCurrent(7, StreamKind.VIDEO, 'new')).toBe(true);
		expect(f.integration.getPendingStreamProducerId(7, StreamKind.VIDEO)).toBe('new');
	});
	it('keeps id-only server compatibility while requiring exact producer and channel identity for repair', () => {
		const f = fixture();
		f.inputs.addPendingStream(7, StreamKind.VIDEO);
		expect(f.integration.isRemoteMediaProducerCurrent(7, StreamKind.VIDEO, 'legacy')).toBe(true);
		f.inputs.addPendingStream(7, StreamKind.VIDEO, 'new');
		const identity = {
			key: getPendingStreamKey(7, StreamKind.VIDEO),
			channelId: 5,
			remoteId: 7,
			kind: StreamKind.VIDEO,
			producerId: 'new',
		};
		expect(f.integration.isRemoteMediaRepairIdentityCurrent(identity)).toBe(true);
		expect(f.integration.isRemoteMediaRepairIdentityCurrent({ ...identity, producerId: 'old' })).toBe(false);
		f.inputs.currentVoiceChannelId = 6;
		expect(f.integration.isRemoteMediaRepairIdentityCurrent(identity)).toBe(false);
	});
	it('settles an aborted publication without waiting for a render', async () => {
		const f = fixture();
		const abort = new AbortController();
		const result = f.integration.publishRemoteMediaConsumeStarted(7, StreamKind.AUDIO, 'mic', 10, false, abort.signal);
		abort.abort();
		expect(await result).toBe(false);
	});
	it('captures desired screen/audio and external intent while excluding auto microphone and unwatched video', () => {
		const f = fixture();
		for (const kind of [StreamKind.AUDIO, StreamKind.VIDEO, StreamKind.SCREEN, StreamKind.SCREEN_AUDIO])
			f.inputs.addPendingStream(7, kind, kind);
		f.integration.acceptStream(7, StreamKind.SCREEN);
		f.inputs.addPendingStream(99, StreamKind.EXTERNAL_AUDIO, 'external', { 99: { audio: true, video: false } });
		f.inputs.markWatchRequested(99, StreamKind.EXTERNAL_AUDIO, { 99: { audio: true, video: false } });
		expect(f.integration.captureWatchedRemoteStreams()).toEqual({
			remoteUserStreams: { 7: [StreamKind.SCREEN, StreamKind.SCREEN_AUDIO] },
			externalStreams: { 99: { audio: true, video: false } },
		});
	});
	it('resynchronizes replacement producers through the ledger without restoring stopped screen intent', () => {
		const f = fixture();
		f.inputs.addPendingStream(7, StreamKind.SCREEN, 'old');
		f.integration.acceptStream(7, StreamKind.SCREEN);
		const snapshot = f.integration.captureWatchedRemoteStreams();
		f.inputs.remoteMediaSubscriptions = clearRemoteMediaProducerStateForTransportCleanup(
			f.inputs.remoteMediaSubscriptions,
			2,
		);
		f.commit(markRemoteWatchStopped(f.inputs.remoteMediaSubscriptions, 7, StreamKind.SCREEN, 3));
		f.commit(rehydrateRemoteMediaWatchIntentOnly(f.inputs.remoteMediaSubscriptions, snapshot, 4));
		const producers: TRemoteProducerIds = {
			remoteAudioIds: [],
			remoteVideoIds: [],
			remoteScreenIds: [7],
			remoteScreenAudioIds: [],
			remoteExternalStreamIds: [],
			remoteScreenProducers: [{ remoteId: 7, producerId: 'new' }],
		};
		const commands = f.commit(
			reconcileRemoteMediaWithProducerSnapshot(f.inputs.remoteMediaSubscriptions, producers, {}, 5),
		);
		expect(f.integration.isRemoteMediaProducerCurrent(7, StreamKind.SCREEN, 'new')).toBe(true);
		expect(commands).toEqual([]);
		expect(f.integration.captureWatchedRemoteStreams().remoteUserStreams).toEqual({});
	});
	it('preserves watched screen intent through recovery and mints replacement consume work', () => {
		const f = fixture();
		f.inputs.addPendingStream(7, StreamKind.SCREEN, 'old');
		f.integration.acceptStream(7, StreamKind.SCREEN);
		const snapshot = f.integration.captureWatchedRemoteStreams();
		f.inputs.remoteMediaSubscriptions = clearRemoteMediaProducerStateForTransportCleanup(
			f.inputs.remoteMediaSubscriptions,
			2,
		);
		f.commit(rehydrateRemoteMediaWatchIntentOnly(f.inputs.remoteMediaSubscriptions, snapshot, 3));
		const commands = f.commit(
			markRemoteProducerPresent(f.inputs.remoteMediaSubscriptions, 7, StreamKind.SCREEN, 4, 'new'),
		);
		expect(commands).toEqual([
			expect.objectContaining({ type: 'consume', producerId: 'new', kind: StreamKind.SCREEN }),
		]);
	});
	it('removes external ledger identity before delegating track teardown to the stream owner', () => {
		const f = fixture();
		f.inputs.addPendingStream(99, StreamKind.EXTERNAL_VIDEO, 'external');
		f.inputs.removeExternalStream = (id) => {
			expect(id).toBe(99);
			expect(f.integration.isRemoteMediaProducerCurrent(99, StreamKind.EXTERNAL_VIDEO, 'external')).toBe(false);
		};
		f.integration.removeExternalStreamAndSubscription(99);
	});
	it('gates manual retry on runtime initialization', () => {
		const f = fixture();
		f.inputs.getRtpCapabilities = () => null;
		f.integration.retryRemoteMedia(7, StreamKind.VIDEO);
		expect(f.inputs.remoteMediaSubscriptions.size).toBe(0);
		expect(f.inputs.log).toHaveBeenCalledTimes(1);
	});
});
