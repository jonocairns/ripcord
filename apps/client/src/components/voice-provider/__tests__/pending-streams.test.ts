import { describe, expect, it } from 'bun:test';
import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import {
	buildActivePendingStreamKeys,
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

	it('removes pending streams with no active producer and refreshes active entries', () => {
		const pendingStreams = new Map<string, TPendingStream>([
			[getPendingStreamKey(1, StreamKind.AUDIO), makePending(1, StreamKind.AUDIO, 100)],
			[getPendingStreamKey(2, StreamKind.VIDEO), makePending(2, StreamKind.VIDEO, 100)],
		]);

		const reconciled = reconcilePendingStreamMap(
			pendingStreams,
			makeProducers({
				remoteAudioIds: [1],
			}),
			undefined,
			200,
		);

		expect(reconciled.has(getPendingStreamKey(2, StreamKind.VIDEO))).toBe(false);
		expect(reconciled.get(getPendingStreamKey(1, StreamKind.AUDIO))).toEqual({
			remoteId: 1,
			kind: StreamKind.AUDIO,
			createdAt: 200,
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
			undefined,
			200,
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
