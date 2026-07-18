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

// Snapshot track metadata marks a track absent only when it is explicitly
// false; missing metadata means "assume present" so a live track is never
// suppressed by stale or incomplete presence info.
export const isExternalTrackPresent = (
	tracks: { audio?: boolean; video?: boolean } | undefined,
	track: 'audio' | 'video',
): boolean => tracks?.[track] !== false;

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

		if (isExternalTrackPresent(tracks, 'audio')) {
			activeKeys.add(getPendingStreamKey(streamId, StreamKind.EXTERNAL_AUDIO));
		}

		if (isExternalTrackPresent(tracks, 'video')) {
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
