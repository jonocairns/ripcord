type TReconnectBufferedAction = () => void;

let isBufferingReconnectSnapshotEvents = false;
let bufferedReconnectSnapshotActions: TReconnectBufferedAction[] = [];

const startReconnectSnapshotEventBuffer = (): void => {
	isBufferingReconnectSnapshotEvents = true;
	// Intentionally do NOT reset bufferedReconnectSnapshotActions here.
	// Events retained from a prior pauseReconnectSnapshotEventBuffer() call
	// (i.e. a failed reconnect attempt) are carried forward so they are
	// replayed together with events from this attempt after a successful
	// snapshot fetch.
};

const bufferReconnectSnapshotEvent = (action: TReconnectBufferedAction): boolean => {
	if (!isBufferingReconnectSnapshotEvents) {
		return false;
	}

	bufferedReconnectSnapshotActions.push(action);
	return true;
};

const flushReconnectSnapshotEventBuffer = (): void => {
	if (!isBufferingReconnectSnapshotEvents) {
		return;
	}

	const actions = bufferedReconnectSnapshotActions;
	isBufferingReconnectSnapshotEvents = false;
	bufferedReconnectSnapshotActions = [];

	for (const action of actions) {
		action();
	}
};

// Stops buffering without discarding the queue. Use this on a failed reconnect
// attempt so that events accumulated during the attempt are carried forward to
// the next retry. Call clearReconnectSnapshotEventBuffer() on final teardown.
const pauseReconnectSnapshotEventBuffer = (): void => {
	isBufferingReconnectSnapshotEvents = false;
};

const clearReconnectSnapshotEventBuffer = (): void => {
	isBufferingReconnectSnapshotEvents = false;
	bufferedReconnectSnapshotActions = [];
};

export {
	bufferReconnectSnapshotEvent,
	clearReconnectSnapshotEventBuffer,
	flushReconnectSnapshotEventBuffer,
	pauseReconnectSnapshotEventBuffer,
	startReconnectSnapshotEventBuffer,
};
