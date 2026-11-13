import { StreamKind } from '@sharkord/shared';

type TWatchedStreamKind = StreamKind.VIDEO | StreamKind.SCREEN;

const isWatchedStreamKind = (kind: StreamKind): kind is TWatchedStreamKind =>
	kind === StreamKind.VIDEO || kind === StreamKind.SCREEN;

const getStreamKey = (remoteId: number, kind: TWatchedStreamKind) => `${remoteId}:${kind}`;

// Who is watching which stream, as a viewer decision rather than a media
// connection. Consumers come and go during repairs, retries, transport rebuilds
// and producer restores; membership changes only when a viewer starts or stops
// watching, a stream ends, or someone leaves the channel. Watcher activity
// events (and the streamer's join/leave sounds) follow this, not consumers.
class StreamWatchers {
	private watchersByStream = new Map<string, Set<number>>();

	// Returns true only when the viewer was not already watching.
	public add = (watcherId: number, remoteId: number, kind: StreamKind): boolean => {
		if (!isWatchedStreamKind(kind) || watcherId === remoteId) {
			return false;
		}

		const key = getStreamKey(remoteId, kind);
		const watchers = this.watchersByStream.get(key) ?? new Set<number>();

		if (watchers.has(watcherId)) {
			return false;
		}

		watchers.add(watcherId);
		this.watchersByStream.set(key, watchers);
		return true;
	};

	// Returns true only when the viewer was watching.
	public remove = (watcherId: number, remoteId: number, kind: StreamKind): boolean => {
		if (!isWatchedStreamKind(kind)) {
			return false;
		}

		const key = getStreamKey(remoteId, kind);
		const watchers = this.watchersByStream.get(key);

		if (!watchers?.delete(watcherId)) {
			return false;
		}

		if (watchers.size === 0) {
			this.watchersByStream.delete(key);
		}

		return true;
	};

	public removeStream = (remoteId: number, kind: StreamKind) => {
		if (!isWatchedStreamKind(kind)) {
			return;
		}

		this.watchersByStream.delete(getStreamKey(remoteId, kind));
	};

	public getWatcherIds = (remoteId: number, kind: StreamKind): number[] => {
		if (!isWatchedStreamKind(kind)) {
			return [];
		}

		return [...(this.watchersByStream.get(getStreamKey(remoteId, kind)) ?? [])];
	};

	// Drops the user both as a viewer and as a streamer.
	public removeUser = (userId: number) => {
		this.removeStream(userId, StreamKind.VIDEO);
		this.removeStream(userId, StreamKind.SCREEN);

		for (const [key, watchers] of this.watchersByStream) {
			watchers.delete(userId);

			if (watchers.size === 0) {
				this.watchersByStream.delete(key);
			}
		}
	};
}

export { StreamWatchers };
