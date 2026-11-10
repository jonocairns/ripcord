import type { TJoinedMessage } from '@sharkord/shared';

type TMutation = { message: TJoinedMessage; insert?: boolean } | { deletedId: number };

// One journal per mounted loader. Superseding or disposing a request immediately
// releases its journal; replay never calls subscription side effects (sounds/read).
export const createMessagePageRequest = () => {
	let generation = 0;
	let journal: TMutation[] | undefined;
	return {
		invalidate: () => {
			generation += 1;
			journal = undefined;
		},
		record: (mutation: TMutation) => journal?.push(mutation),
		begin: (isSessionCurrent: () => boolean, reconcile: boolean) => {
			const requestGeneration = ++generation;
			const events: TMutation[] = [];
			journal = reconcile ? events : undefined;
			return {
				isCurrent: () => requestGeneration === generation && isSessionCurrent(),
				reconcile: (page: TJoinedMessage[]) => {
					const messages = new Map(page.map((message) => [message.id, message]));
					for (const event of events) {
						if ('deletedId' in event) messages.delete(event.deletedId);
						else if (event.insert || messages.has(event.message.id)) messages.set(event.message.id, event.message);
					}
					return [...messages.values()].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
				},
				finish: () => {
					if (requestGeneration === generation) journal = undefined;
				},
			};
		},
	};
};

// Actions publish complete rows for edits/reactions, including edits to messages
// not currently cached. Keeping the event, rather than reading the cache later,
// also preserves deletes of rows only present in the in-flight snapshot.
const listeners = new Set<(channelId: number, mutation: TMutation) => void>();
export const recordMessageMutation = (channelId: number, mutation: TMutation) => {
	for (const listener of listeners) listener(channelId, mutation);
};
export const subscribeToMessageMutations = (listener: (channelId: number, mutation: TMutation) => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
