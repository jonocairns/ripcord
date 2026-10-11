import type { TStreamEventDetails } from '@sharkord/shared';
import type { TRemoteMediaSubscriptions } from './remote-media-subscriptions';

export const getWatchIntentEvents = (
	previous: TRemoteMediaSubscriptions,
	next: TRemoteMediaSubscriptions,
): TStreamEventDetails[] => {
	const events: TStreamEventDetails[] = [];
	for (const [key, before] of previous) {
		if (!before.desired) continue;
		const after = next.get(key);
		if (!after?.desired)
			events.push({
				event: 'watch_intent_cleared',
				remoteId: before.remoteId,
				kind: before.kind,
				producerId: before.producerId,
				consumerId: before.consumerId,
				desired: false,
			});
		else if (before.producerPresent && !after.producerPresent)
			events.push({
				event: 'watch_intent_retained',
				remoteId: before.remoteId,
				kind: before.kind,
				producerId: before.producerId,
				consumerId: before.consumerId,
				desired: true,
			});
	}
	return events;
};
