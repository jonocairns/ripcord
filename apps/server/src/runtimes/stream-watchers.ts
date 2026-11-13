import { StreamKind } from '@sharkord/shared';

type TWatchedStreamKind = StreamKind.VIDEO | StreamKind.SCREEN;

type TWatchedStream = {
	remoteId: number;
	kind: TWatchedStreamKind;
};

const isWatchedStreamKind = (kind: StreamKind): kind is TWatchedStreamKind =>
	kind === StreamKind.VIDEO || kind === StreamKind.SCREEN;

const getStreamKey = (remoteId: number, kind: TWatchedStreamKind) => `${remoteId}:${kind}`;

// Who is watching which stream, as a viewer decision rather than a media
// connection. Consumers come and go during repairs, retries, transport rebuilds
// and producer restores; membership changes only when a viewer starts or stops
// watching, a stream ends, or someone leaves the channel. Watcher activity
// events (and the streamer's join/leave sounds) follow this, not consumers.
class StreamWatchers {
	private watchersByStream = new Map<string, { stream: TWatchedStream; watcherIds: Set<number> }>();

	// Returns true only when the viewer was not already watching.
	public add = (watcherId: number, remoteId: number, kind: StreamKind): boolean => {
		if (!isWatchedStreamKind(kind) || watcherId === remoteId) {
			return false;
		}

		const key = getStreamKey(remoteId, kind);
		const entry = this.watchersByStream.get(key) ?? { stream: { remoteId, kind }, watcherIds: new Set<number>() };

		if (entry.watcherIds.has(watcherId)) {
			return false;
		}

		entry.watcherIds.add(watcherId);
		this.watchersByStream.set(key, entry);
		return true;
	};

	// Returns true only when the viewer was watching.
	public remove = (watcherId: number, remoteId: number, kind: StreamKind): boolean => {
		if (!isWatchedStreamKind(kind)) {
			return false;
		}

		const key = getStreamKey(remoteId, kind);
		const entry = this.watchersByStream.get(key);

		if (!entry?.watcherIds.delete(watcherId)) {
			return false;
		}

		if (entry.watcherIds.size === 0) {
			this.watchersByStream.delete(key);
		}

		return true;
	};

	public has = (watcherId: number, remoteId: number, kind: StreamKind): boolean =>
		isWatchedStreamKind(kind) &&
		this.watchersByStream.get(getStreamKey(remoteId, kind))?.watcherIds.has(watcherId) === true;

	public removeStream = (remoteId: number, kind: StreamKind) => {
		if (!isWatchedStreamKind(kind)) {
			return;
		}

		this.watchersByStream.delete(getStreamKey(remoteId, kind));
	};

	public getWatchedStreams = (watcherId: number): TWatchedStream[] =>
		[...this.watchersByStream.values()].filter((entry) => entry.watcherIds.has(watcherId)).map((entry) => entry.stream);

	// Drops the user both as a viewer and as a streamer, returning the streams
	// they were watching so their streamers can be told.
	public removeUser = (userId: number): TWatchedStream[] => {
		this.removeStream(userId, StreamKind.VIDEO);
		this.removeStream(userId, StreamKind.SCREEN);

		const watched = this.getWatchedStreams(userId);

		for (const { remoteId, kind } of watched) {
			this.remove(userId, remoteId, kind);
		}

		return watched;
	};
}

export { StreamWatchers };
