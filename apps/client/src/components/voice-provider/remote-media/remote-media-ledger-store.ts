import {
	clearRemoteMediaProducerStateForTransportCleanup,
	hasSubscriptionChanged,
	remoteMediaSubscriptionsToPendingStreams,
	remoteMediaSubscriptionsToVisibleRemoteMedia,
	type TRemoteMediaCommand,
	type TRemoteMediaReducerResult,
	type TRemoteMediaSubscriptions,
} from './remote-media-subscriptions';

export const createRemoteMediaLedgerStore = (ports: {
	now: () => number;
	onTransition?: (previous: TRemoteMediaSubscriptions, next: TRemoteMediaSubscriptions) => void;
	onCommandError?: (error: unknown, command: TRemoteMediaCommand) => void;
}) => {
	let snapshot: TRemoteMediaSubscriptions = new Map();
	let pending = remoteMediaSubscriptionsToPendingStreams(snapshot);
	let visible = remoteMediaSubscriptionsToVisibleRemoteMedia(snapshot);
	const listeners = new Set<() => void>();
	const queue: TRemoteMediaCommand[] = [];
	let runner: ((command: TRemoteMediaCommand) => void) | undefined;
	let draining = false;
	const drain = () => {
		if (draining) return;
		draining = true;
		try {
			while (runner && queue.length) {
				const command = queue.shift();
				if (!command) break;
				try {
					runner(command);
				} catch (error) {
					ports.onCommandError?.(error, command);
				}
			}
		} finally {
			draining = false;
		}
	};
	const commit = (next: TRemoteMediaSubscriptions) => {
		if (!hasSubscriptionChanged(snapshot, next)) return;
		const previous = snapshot;
		snapshot = next;
		pending = remoteMediaSubscriptionsToPendingStreams(snapshot);
		visible = remoteMediaSubscriptionsToVisibleRemoteMedia(snapshot);
		ports.onTransition?.(previous, snapshot);
		for (const listener of listeners) listener();
	};
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		dispatch: (nextFor: (previous: TRemoteMediaSubscriptions, now: number) => TRemoteMediaReducerResult) => {
			const result = nextFor(snapshot, ports.now());
			queue.push(...result.commands);
			try {
				commit(result.state);
			} finally {
				drain();
			}
		},
		clear: (opts?: { preserveIntent?: boolean }) => {
			queue.length = 0;
			commit(
				opts?.preserveIntent ? clearRemoteMediaProducerStateForTransportCleanup(snapshot, ports.now()) : new Map(),
			);
		},
		setCommandRunner: (next: typeof runner) => {
			runner = next;
			drain();
		},
		getPendingStreams: () => pending,
		getVisibleRemoteMedia: () => visible,
	};
};
export type TRemoteMediaLedgerStore = ReturnType<typeof createRemoteMediaLedgerStore>;
