import type { StreamKind } from '@sharkord/shared';

// Commit stopped intent before close notifications can synchronously request a
// new consume. Cancellation still fences late allocations in the same turn.
export const stopRemoteMediaWatch = (
	remoteId: number,
	kind: StreamKind,
	ports: {
		markWatchStopped: (remoteId: number, kind: StreamKind) => void;
		cancel: (remoteId: number, kind: StreamKind) => void;
	},
): void => {
	ports.markWatchStopped(remoteId, kind);
	ports.cancel(remoteId, kind);
};

type TRemoteMediaTransportCleanupPorts = {
	clear: (opts?: { preserveIntent?: boolean }) => void;
	invalidateTransport: () => void;
};

// Clear first so transport invalidation emits no spurious re-consume command.
export const clearRemoteMediaForTransport = (
	ports: TRemoteMediaTransportCleanupPorts,
	opts?: { preserveIntent?: boolean },
): void => {
	ports.clear(opts);
	ports.invalidateTransport();
};

// Failure cleanup runs before recovery captures its snapshot. Keep desired watch
// intent readable until recovery or terminal cleanup decides its lifetime.
export const clearRemoteMediaForTransportFailure = (ports: TRemoteMediaTransportCleanupPorts): void => {
	clearRemoteMediaForTransport(ports, { preserveIntent: true });
};
