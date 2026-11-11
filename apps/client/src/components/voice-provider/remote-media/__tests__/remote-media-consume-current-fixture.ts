import { StreamKind } from '@sharkord/shared';
import type { TRemoteMediaSubscription, TRemoteMediaSubscriptions } from '../remote-media-subscriptions';
import { getPendingStreamKey } from '../use-pending-streams';

export const consumeStartCases: {
	name: string;
	slot?: Partial<TRemoteMediaSubscription>;
	expected?: string;
	current: boolean;
}[] = [
	{ name: 'same generation', slot: {}, expected: 'p1', current: true },
	{ name: 'newer generation', slot: { consumeGeneration: 2 }, expected: 'p1', current: false },
	{ name: 'producer gone', slot: { producerPresent: false }, expected: 'p1', current: false },
	{ name: 'producer replaced', slot: { producerId: 'p2' }, expected: 'p1', current: false },
	{ name: 'no expected id', slot: {}, current: true },
	{ name: 'no recorded id', slot: { producerId: undefined }, expected: 'p1', current: true },
	{ name: 'no slot', current: false },
];
export const subscriptionsFor = (slot: Partial<TRemoteMediaSubscription> | undefined): TRemoteMediaSubscriptions => {
	const key = getPendingStreamKey(7, StreamKind.VIDEO);
	return new Map(
		slot === undefined
			? []
			: [
					[
						key,
						{
							key,
							remoteId: 7,
							kind: StreamKind.VIDEO,
							producerPresent: true,
							producerId: 'p1',
							desired: true,
							status: 'consuming',
							consumeGeneration: 1,
							updatedAt: 1,
							...slot,
						},
					],
				],
	);
};
