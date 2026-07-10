import { describe, expect, it } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import type { TPendingVoiceReconnect } from '@/features/server/voice/reconnect-coordinator';
import {
	createInitialVoiceSessionState,
	reduceVoiceSession,
	type TVoiceSessionCommand,
	type TVoiceSessionState,
	type TWatchedRemoteStreamsSnapshot,
} from '@/features/server/voice/voice-session-machine';
import {
	clearRemoteMediaProducerStateForTransportCleanup,
	markRemoteProducerPresent,
	markRemoteWatchRequested,
	markRemoteWatchStopped,
	rehydrateRemoteMediaWatchIntentOnly,
	remoteMediaState,
	type TRemoteMediaSubscriptions,
} from '../hooks/remote-media-subscriptions';
import { getPendingStreamKey } from '../hooks/use-pending-streams';

const pendingReconnect = (overrides: Partial<TPendingVoiceReconnect> = {}): TPendingVoiceReconnect => ({
	channelId: 5,
	micMuted: false,
	soundMuted: false,
	peerUserIds: [10, 20],
	expiresAt: 10_000,
	...overrides,
});

const watchedSnapshot = (): TWatchedRemoteStreamsSnapshot => ({
	remoteUserStreams: {
		10: [StreamKind.VIDEO],
		20: [StreamKind.SCREEN, StreamKind.SCREEN_AUDIO],
	},
	externalStreams: {
		99: { audio: true, video: true },
		100: { audio: true, video: false },
	},
});

const dispatch = (
	state: TVoiceSessionState,
	event: Parameters<typeof reduceVoiceSession>[1],
): [TVoiceSessionState, TVoiceSessionCommand[]] => {
	const result = reduceVoiceSession(state, event);

	return [result.state, result.commands];
};

const startReconnectWithSnapshot = (): [TVoiceSessionState, number] => {
	let state = createInitialVoiceSessionState();
	let commands: TVoiceSessionCommand[];

	[state, commands] = dispatch(state, {
		type: 'WsDropped',
		pending: pendingReconnect(),
		now: 100,
		online: true,
		authenticated: true,
	});

	expect(commands).toEqual([expect.objectContaining({ type: 'CaptureRecoverySnapshot' })]);
	const generation = commands[0]?.generation;

	if (generation === undefined) {
		throw new Error('expected reconnect generation');
	}

	[state, commands] = dispatch(state, {
		type: 'RecoveryStarted',
		generation,
		snapshot: watchedSnapshot(),
	});

	expect(commands).toEqual([expect.objectContaining({ type: 'RestoreVoiceSession', generation })]);

	return [state, generation];
};

describe('voice WS-reconnect watch restoration', () => {
	it('captures watched intent before restore and emits a ledger restore command after restore succeeds', () => {
		let [state, generation] = startReconnectWithSnapshot();
		let commands: TVoiceSessionCommand[];

		[state, commands] = dispatch(state, {
			type: 'RestoreSucceeded',
			generation,
			serverSessionEstablished: true,
		});

		expect(state.phase).toMatchObject({ phase: 'reconnecting', step: 'restoreWatch' });
		expect(commands).toEqual([
			expect.objectContaining({
				type: 'RestoreWatchIntent',
				generation,
				snapshot: watchedSnapshot(),
			}),
		]);

		[state, commands] = dispatch(state, { type: 'WatchIntentRehydrated', generation });

		expect(state.phase).toEqual({ phase: 'connected', channelId: 5 });
		expect(state.pendingVoiceReconnect).toBeUndefined();
		expect(state.reconnectingSince).toBeUndefined();
		expect(state.suppression).toEqual({
			channelId: 5,
			peerUserIds: [10, 20],
			expiresAt: 10_000,
		});
		expect(commands).toEqual([]);
	});

	it('rehydrates watched remote streams into ledger consume commands', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(rehydrateRemoteMediaWatchIntentOnly(state, watchedSnapshot(), 100));

		expect(state.get(getPendingStreamKey(10, StreamKind.VIDEO))).toMatchObject({
			desired: true,
			producerPresent: false,
			status: 'failed',
		});

		const videoResult = markRemoteProducerPresent(state, 10, StreamKind.VIDEO, 110, 'video-producer');
		state = videoResult.state;
		const screenResult = markRemoteProducerPresent(state, 20, StreamKind.SCREEN, 110, 'screen-producer');
		state = screenResult.state;
		const screenAudioResult = markRemoteProducerPresent(
			state,
			20,
			StreamKind.SCREEN_AUDIO,
			110,
			'screen-audio-producer',
		);
		state = screenAudioResult.state;
		const commands = [...videoResult.commands, ...screenResult.commands, ...screenAudioResult.commands];

		expect(state.get(getPendingStreamKey(10, StreamKind.VIDEO))).toMatchObject({
			desired: true,
			status: 'wanted',
		});
		expect(state.get(getPendingStreamKey(20, StreamKind.SCREEN))).toMatchObject({
			desired: true,
			status: 'wanted',
		});
		expect(state.get(getPendingStreamKey(20, StreamKind.SCREEN_AUDIO))).toMatchObject({
			desired: true,
			status: 'wanted',
		});
		expect(commands).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'consume', remoteId: 10, kind: StreamKind.VIDEO }),
				expect.objectContaining({ type: 'consume', remoteId: 20, kind: StreamKind.SCREEN }),
				expect.objectContaining({ type: 'consume', remoteId: 20, kind: StreamKind.SCREEN_AUDIO }),
			]),
		);
	});

	it('does not resurrect a stream stopped after the recovery snapshot is rehydrated', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(markRemoteProducerPresent(state, 10, StreamKind.VIDEO, 100, 'video-producer'));
		state = remoteMediaState(markRemoteWatchRequested(state, 10, StreamKind.VIDEO, 101));
		state = clearRemoteMediaProducerStateForTransportCleanup(state, 110);
		state = remoteMediaState(rehydrateRemoteMediaWatchIntentOnly(state, watchedSnapshot(), 111));

		state = remoteMediaState(markRemoteWatchStopped(state, 10, StreamKind.VIDEO, 112));

		// A retry cleanup should preserve the user's stopped intent, and reapplying
		// the old recovery snapshot must not flip desired back to true.
		state = clearRemoteMediaProducerStateForTransportCleanup(state, 120);
		state = remoteMediaState(rehydrateRemoteMediaWatchIntentOnly(state, watchedSnapshot(), 121));

		const result = markRemoteProducerPresent(state, 10, StreamKind.VIDEO, 130, 'new-video-producer');

		expect(result.state.get(getPendingStreamKey(10, StreamKind.VIDEO))).toMatchObject({
			desired: false,
			producerPresent: true,
			status: 'available',
		});
		expect(result.commands).toEqual([]);
	});

	it('rehydrates watched external stream intent through track-aware ledger commands', () => {
		let state: TRemoteMediaSubscriptions = new Map();

		state = remoteMediaState(rehydrateRemoteMediaWatchIntentOnly(state, watchedSnapshot(), 100));
		const externalStreamTracks = {
			99: { audio: true, video: true },
			100: { audio: true, video: false },
		};
		const audioResult = markRemoteProducerPresent(state, 99, StreamKind.EXTERNAL_AUDIO, 110, undefined, {
			externalStreamTracks,
		});
		state = audioResult.state;
		const videoResult = markRemoteProducerPresent(state, 99, StreamKind.EXTERNAL_VIDEO, 110, undefined, {
			externalStreamTracks,
		});
		state = videoResult.state;
		const secondAudioResult = markRemoteProducerPresent(state, 100, StreamKind.EXTERNAL_AUDIO, 110, undefined, {
			externalStreamTracks,
		});
		const commands = [...audioResult.commands, ...videoResult.commands, ...secondAudioResult.commands];

		expect(commands).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'consume', remoteId: 99, kind: StreamKind.EXTERNAL_AUDIO }),
				expect.objectContaining({ type: 'consume', remoteId: 99, kind: StreamKind.EXTERNAL_VIDEO }),
				expect.objectContaining({ type: 'consume', remoteId: 100, kind: StreamKind.EXTERNAL_AUDIO }),
			]),
		);
		expect(
			commands.some(
				(command) =>
					command.type === 'consume' && command.remoteId === 100 && command.kind === StreamKind.EXTERNAL_VIDEO,
			),
		).toBe(false);
	});

	it('drops stale restore results instead of completing a superseded reconnect', () => {
		const [state, generation] = startReconnectWithSnapshot();
		const result = reduceVoiceSession(state, {
			type: 'WatchIntentRehydrated',
			generation: generation + 1,
		});

		expect(result.state).toBe(state);
		expect(result.commands).toEqual([]);
	});
});
