import { describe, expect, it } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import {
	selectWatchedPendingScreenAudioIds,
	tracksScreenAudioWatchIntent,
} from '../hooks/screen-audio-watch-intent';
import { getPendingStreamKey, type TPendingStream } from '../hooks/use-pending-streams';

const makePendingMap = (streams: TPendingStream[]) =>
	new Map(streams.map((stream) => [getPendingStreamKey(stream.remoteId, stream.kind), stream]));

const makePending = (remoteId: number, kind: StreamKind): TPendingStream => ({
	remoteId,
	kind,
	createdAt: 100,
});

describe('screen-audio watch intent', () => {
	it('is tracked by screen and screen-audio accepts only', () => {
		expect(tracksScreenAudioWatchIntent(StreamKind.SCREEN)).toBe(true);
		expect(tracksScreenAudioWatchIntent(StreamKind.SCREEN_AUDIO)).toBe(true);
		expect(tracksScreenAudioWatchIntent(StreamKind.AUDIO)).toBe(false);
		expect(tracksScreenAudioWatchIntent(StreamKind.VIDEO)).toBe(false);
		expect(tracksScreenAudioWatchIntent(StreamKind.EXTERNAL_AUDIO)).toBe(false);
		expect(tracksScreenAudioWatchIntent(StreamKind.EXTERNAL_VIDEO)).toBe(false);
	});

	it('consumes screen audio that appears after the viewer accepted the screen', () => {
		const sharerId = 3;
		const intent = new Set<number>();

		// Viewer accepts the screen while the sharer has no audio yet.
		if (tracksScreenAudioWatchIntent(StreamKind.SCREEN)) {
			intent.add(sharerId);
		}

		const beforeAudioAppears = makePendingMap([makePending(sharerId, StreamKind.SCREEN)]);

		expect(selectWatchedPendingScreenAudioIds(beforeAudioAppears, (remoteId) => intent.has(remoteId))).toEqual([]);

		// Sharer enables audio later; its pending entry arrives via the new
		// producer event. Intent from the screen accept alone drives the consume.
		const afterAudioAppears = makePendingMap([
			makePending(sharerId, StreamKind.SCREEN),
			makePending(sharerId, StreamKind.SCREEN_AUDIO),
		]);

		expect(selectWatchedPendingScreenAudioIds(afterAudioAppears, (remoteId) => intent.has(remoteId))).toEqual([
			sharerId,
		]);
	});

	it('does not consume screen audio for sharers the viewer never accepted', () => {
		const pendingStreams = makePendingMap([
			makePending(3, StreamKind.SCREEN_AUDIO),
			makePending(4, StreamKind.SCREEN_AUDIO),
		]);

		expect(selectWatchedPendingScreenAudioIds(pendingStreams, (remoteId) => remoteId === 4)).toEqual([4]);
		expect(selectWatchedPendingScreenAudioIds(pendingStreams, () => false)).toEqual([]);
	});

	it('stops consuming once intent is cleared by an opt-out', () => {
		const sharerId = 3;
		const intent = new Set<number>([sharerId]);
		const pendingStreams = makePendingMap([makePending(sharerId, StreamKind.SCREEN_AUDIO)]);

		expect(selectWatchedPendingScreenAudioIds(pendingStreams, (remoteId) => intent.has(remoteId))).toEqual([
			sharerId,
		]);

		// stopWatchingStream(SCREEN) clears intent even while audio is only pending.
		if (tracksScreenAudioWatchIntent(StreamKind.SCREEN)) {
			intent.delete(sharerId);
		}

		expect(selectWatchedPendingScreenAudioIds(pendingStreams, (remoteId) => intent.has(remoteId))).toEqual([]);
	});
});
