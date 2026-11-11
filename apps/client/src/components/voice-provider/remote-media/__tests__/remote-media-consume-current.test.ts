import { expect, test } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import { isRemoteConsumeStartCurrent } from '../remote-media-subscriptions';
import { consumeStartCases, subscriptionsFor } from './remote-media-consume-current-fixture';

for (const row of consumeStartCases)
	test(row.name, () => {
		expect(
			isRemoteConsumeStartCurrent(
				subscriptionsFor(row.slot),
				{ remoteId: 7, kind: StreamKind.VIDEO, expectedProducerId: row.expected },
				1,
			),
		).toBe(row.current);
	});
