import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';

export const PENDING_STREAM_REPAIR_AGE_MS = 15_000;

export type TPendingStream = {
	remoteId: number;
	kind: StreamKind;
	createdAt: number;
	producerId?: string;
};

export type TExternalStreamTrackPresence = {
	[streamId: number]: { audio?: boolean; video?: boolean };
};

export const getPendingStreamKey = (remoteId: number, kind: StreamKind) => `${remoteId}-${kind}`;

export type TIsExternalStreamWatched = (
	streamId: number,
	kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO,
) => boolean;

export type TIsScreenAudioWatched = (remoteId: number) => boolean;

/**
 * Oldest `createdAt` among pending streams the client auto-consumes and can
 * therefore repair. VIDEO/SCREEN pendings are watch-on-demand ("stream
 * available" markers) and stay pending indefinitely by design, so they must
 * never arm the stale-stream repair timer. External tracks and SCREEN_AUDIO
 * are only auto-consumed while their stream is watched.
 */
export const getOldestRepairEligiblePendingCreatedAt = (
	pendingStreams: Map<string, TPendingStream>,
	isExternalStreamWatched: TIsExternalStreamWatched,
	isScreenAudioWatched: TIsScreenAudioWatched,
): number | undefined => {
	let oldestCreatedAt: number | undefined;

	pendingStreams.forEach((stream) => {
		if (stream.kind === StreamKind.EXTERNAL_AUDIO || stream.kind === StreamKind.EXTERNAL_VIDEO) {
			if (!isExternalStreamWatched(stream.remoteId, stream.kind)) {
				return;
			}
		} else if (stream.kind === StreamKind.SCREEN_AUDIO) {
			if (!isScreenAudioWatched(stream.remoteId)) {
				return;
			}
		} else if (stream.kind !== StreamKind.AUDIO) {
			return;
		}

		if (oldestCreatedAt === undefined || stream.createdAt < oldestCreatedAt) {
			oldestCreatedAt = stream.createdAt;
		}
	});

	return oldestCreatedAt;
};

const addActiveKeysForIds = (activeKeys: Set<string>, ids: number[], kind: StreamKind): void => {
	ids.forEach((remoteId) => {
		activeKeys.add(getPendingStreamKey(remoteId, kind));
	});
};

export const buildActivePendingStreamKeys = (
	producers: TRemoteProducerIds,
	externalStreamTracks?: TExternalStreamTrackPresence,
): Set<string> => {
	const activeKeys = new Set<string>();

	addActiveKeysForIds(activeKeys, producers.remoteAudioIds, StreamKind.AUDIO);
	addActiveKeysForIds(activeKeys, producers.remoteVideoIds, StreamKind.VIDEO);
	addActiveKeysForIds(activeKeys, producers.remoteScreenIds, StreamKind.SCREEN);
	addActiveKeysForIds(activeKeys, producers.remoteScreenAudioIds, StreamKind.SCREEN_AUDIO);

	producers.remoteExternalStreamIds.forEach((streamId) => {
		const tracks = externalStreamTracks?.[streamId];

		if (tracks === undefined || tracks.audio !== false) {
			activeKeys.add(getPendingStreamKey(streamId, StreamKind.EXTERNAL_AUDIO));
		}

		if (tracks === undefined || tracks.video !== false) {
			activeKeys.add(getPendingStreamKey(streamId, StreamKind.EXTERNAL_VIDEO));
		}
	});

	return activeKeys;
};

export const reconcilePendingStreamMap = (
	pendingStreams: Map<string, TPendingStream>,
	producers: TRemoteProducerIds,
	externalStreamTracks?: TExternalStreamTrackPresence,
): Map<string, TPendingStream> => {
	if (pendingStreams.size === 0) {
		return pendingStreams;
	}

	const activeKeys = buildActivePendingStreamKeys(producers, externalStreamTracks);
	let changed = false;
	const next = new Map<string, TPendingStream>();

	pendingStreams.forEach((stream, key) => {
		if (!activeKeys.has(key)) {
			changed = true;
			return;
		}

		next.set(key, stream);
	});

	return changed ? next : pendingStreams;
};
