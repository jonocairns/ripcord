type TReconnectBufferedAction = () => void;

let isBufferingReconnectSnapshotEvents = false;
let bufferedReconnectSnapshotActions: TReconnectBufferedAction[] = [];

const startReconnectSnapshotEventBuffer = (): void => {
	isBufferingReconnectSnapshotEvents = true;
	bufferedReconnectSnapshotActions = [];
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

const clearReconnectSnapshotEventBuffer = (): void => {
	isBufferingReconnectSnapshotEvents = false;
	bufferedReconnectSnapshotActions = [];
};

export {
	bufferReconnectSnapshotEvent,
	clearReconnectSnapshotEventBuffer,
	flushReconnectSnapshotEventBuffer,
	startReconnectSnapshotEventBuffer,
};
