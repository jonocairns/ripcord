import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import { useCallback, useState } from 'react';

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

const isUserPendingStreamKind = (kind: StreamKind) => {
	return (
		kind === StreamKind.AUDIO ||
		kind === StreamKind.VIDEO ||
		kind === StreamKind.SCREEN ||
		kind === StreamKind.SCREEN_AUDIO
	);
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
	now: number = Date.now(),
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

		if (stream.createdAt !== now) {
			changed = true;
			next.set(key, { ...stream, createdAt: now });
			return;
		}

		next.set(key, stream);
	});

	return changed ? next : pendingStreams;
};

const usePendingStreams = () => {
	const [pendingStreams, setPendingStreams] = useState<Map<string, TPendingStream>>(() => new Map());

	const addPendingStream = useCallback((remoteId: number, kind: StreamKind, producerId?: string) => {
		setPendingStreams((prev) => {
			const key = getPendingStreamKey(remoteId, kind);
			const existing = prev.get(key);

			if (existing !== undefined && (producerId === undefined || existing.producerId === producerId)) {
				return prev;
			}

			const next = new Map(prev);
			next.set(key, { remoteId, kind, createdAt: Date.now(), producerId });

			return next;
		});
	}, []);

	const removePendingStream = useCallback((remoteId: number, kind: StreamKind) => {
		setPendingStreams((prev) => {
			const key = getPendingStreamKey(remoteId, kind);

			if (!prev.has(key)) {
				return prev;
			}

			const next = new Map(prev);
			next.delete(key);

			return next;
		});
	}, []);

	const clearPendingStreamsForUser = useCallback((remoteId: number) => {
		setPendingStreams((prev) => {
			let changed = false;
			const next = new Map(prev);

			next.forEach((stream, key) => {
				if (stream.remoteId !== remoteId || !isUserPendingStreamKind(stream.kind)) {
					return;
				}

				next.delete(key);
				changed = true;
			});

			return changed ? next : prev;
		});
	}, []);

	const clearAllPendingStreams = useCallback(() => {
		setPendingStreams((prev) => {
			if (prev.size === 0) {
				return prev;
			}

			return new Map();
		});
	}, []);

	const reconcilePendingStreams = useCallback(
		(producers: TRemoteProducerIds, externalStreamTracks?: TExternalStreamTrackPresence) => {
			setPendingStreams((prev) => reconcilePendingStreamMap(prev, producers, externalStreamTracks));
		},
		[],
	);

	return {
		pendingStreams,
		addPendingStream,
		removePendingStream,
		clearPendingStreamsForUser,
		clearAllPendingStreams,
		reconcilePendingStreams,
	};
};

export { usePendingStreams };
