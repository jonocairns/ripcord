import { describe, expect, it } from 'bun:test';
import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import {
	buildActivePendingStreamKeys,
	getOldestRepairEligiblePendingCreatedAt,
	getPendingStreamKey,
	reconcilePendingStreamMap,
	type TPendingStream,
} from '../hooks/use-pending-streams';

const makeProducers = (overrides: Partial<TRemoteProducerIds> = {}): TRemoteProducerIds => ({
	remoteAudioIds: [],
	remoteVideoIds: [],
	remoteScreenIds: [],
	remoteScreenAudioIds: [],
	remoteExternalStreamIds: [],
	...overrides,
});

const makePending = (remoteId: number, kind: StreamKind, createdAt: number): TPendingStream => ({
	remoteId,
	kind,
	createdAt,
});

describe('pending stream reconciliation', () => {
	it('builds active pending keys from producer snapshots', () => {
		const keys = buildActivePendingStreamKeys(
			makeProducers({
				remoteAudioIds: [1],
				remoteVideoIds: [2],
				remoteScreenIds: [3],
				remoteScreenAudioIds: [3],
				remoteExternalStreamIds: [50],
			}),
			{ 50: { audio: true, video: false } },
		);

		expect(keys.has(getPendingStreamKey(1, StreamKind.AUDIO))).toBe(true);
		expect(keys.has(getPendingStreamKey(2, StreamKind.VIDEO))).toBe(true);
		expect(keys.has(getPendingStreamKey(3, StreamKind.SCREEN))).toBe(true);
		expect(keys.has(getPendingStreamKey(3, StreamKind.SCREEN_AUDIO))).toBe(true);
		expect(keys.has(getPendingStreamKey(50, StreamKind.EXTERNAL_AUDIO))).toBe(true);
		expect(keys.has(getPendingStreamKey(50, StreamKind.EXTERNAL_VIDEO))).toBe(false);
	});

	it('removes pending streams with no active producer and preserves active entry age', () => {
		const pendingStreams = new Map<string, TPendingStream>([
			[getPendingStreamKey(1, StreamKind.AUDIO), makePending(1, StreamKind.AUDIO, 100)],
			[getPendingStreamKey(2, StreamKind.VIDEO), makePending(2, StreamKind.VIDEO, 100)],
		]);

		const reconciled = reconcilePendingStreamMap(
			pendingStreams,
			makeProducers({
				remoteAudioIds: [1],
			}),
		);

		expect(reconciled.has(getPendingStreamKey(2, StreamKind.VIDEO))).toBe(false);
		expect(reconciled.get(getPendingStreamKey(1, StreamKind.AUDIO))).toEqual({
			remoteId: 1,
			kind: StreamKind.AUDIO,
			createdAt: 100,
		});
	});

	it('keeps external pending tracks when track-level presence is unavailable', () => {
		const pendingStreams = new Map<string, TPendingStream>([
			[getPendingStreamKey(50, StreamKind.EXTERNAL_AUDIO), makePending(50, StreamKind.EXTERNAL_AUDIO, 100)],
			[getPendingStreamKey(50, StreamKind.EXTERNAL_VIDEO), makePending(50, StreamKind.EXTERNAL_VIDEO, 100)],
		]);

		const reconciled = reconcilePendingStreamMap(
			pendingStreams,
			makeProducers({
				remoteExternalStreamIds: [50],
			}),
		);

		expect(reconciled.has(getPendingStreamKey(50, StreamKind.EXTERNAL_AUDIO))).toBe(true);
		expect(reconciled.has(getPendingStreamKey(50, StreamKind.EXTERNAL_VIDEO))).toBe(true);
	});

	it('keeps external pending tracks when track-level fields are unset', () => {
		const keys = buildActivePendingStreamKeys(
			makeProducers({
				remoteExternalStreamIds: [50],
			}),
			{ 50: {} },
		);

		expect(keys.has(getPendingStreamKey(50, StreamKind.EXTERNAL_AUDIO))).toBe(true);
		expect(keys.has(getPendingStreamKey(50, StreamKind.EXTERNAL_VIDEO))).toBe(true);
	});
});

describe('repair-eligible pending stream age', () => {
	const makePendingMap = (streams: TPendingStream[]) =>
		new Map(streams.map((stream) => [getPendingStreamKey(stream.remoteId, stream.kind), stream]));

	it('ignores watch-on-demand kinds so an unwatched screen share never arms the repair timer', () => {
		const oldest = getOldestRepairEligiblePendingCreatedAt(
			makePendingMap([
				makePending(3, StreamKind.SCREEN, 100),
				makePending(3, StreamKind.SCREEN_AUDIO, 100),
				makePending(2, StreamKind.VIDEO, 100),
			]),
			() => true,
		);

		expect(oldest).toBeUndefined();
	});

	it('returns the oldest audio pending age', () => {
		const oldest = getOldestRepairEligiblePendingCreatedAt(
			makePendingMap([
				makePending(1, StreamKind.AUDIO, 300),
				makePending(3, StreamKind.SCREEN, 100),
				makePending(4, StreamKind.AUDIO, 200),
			]),
			() => false,
		);

		expect(oldest).toBe(200);
	});

	it('includes external pendings only while their stream is watched', () => {
		const pendingStreams = makePendingMap([
			makePending(50, StreamKind.EXTERNAL_AUDIO, 100),
			makePending(50, StreamKind.EXTERNAL_VIDEO, 50),
		]);

		expect(
			getOldestRepairEligiblePendingCreatedAt(
				pendingStreams,
				(_streamId, kind) => kind === StreamKind.EXTERNAL_AUDIO,
			),
		).toBe(100);
		expect(getOldestRepairEligiblePendingCreatedAt(pendingStreams, () => false)).toBeUndefined();
	});
});
