import { describe, expect, it } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import { createRemoteMediaConsumeStartPublication } from '../remote-media-consume-start-publication';
import {
	markRemoteConsumeStarted,
	markRemoteProducerClosed,
	markRemoteProducerPresent,
	type TRemoteMediaSubscriptions,
} from '../remote-media-subscriptions';

describe('remote media consume start publication', () => {
	it('acknowledges a direct consume after its missing slot is published', async () => {
		const publication = createRemoteMediaConsumeStartPublication();
		const abortController = new AbortController();
		const published = publication.wait({ remoteId: 7, kind: StreamKind.AUDIO }, 1, abortController.signal);
		const subscriptions = markRemoteConsumeStarted(new Map(), 7, StreamKind.AUDIO, 1, undefined, 1).state;

		publication.reconcile(subscriptions);

		expect(await published).toBe(true);
	});

	it('rejects a start whose producer closes in the same publication window', async () => {
		const publication = createRemoteMediaConsumeStartPublication();
		const abortController = new AbortController();
		const published = publication.wait(
			{ remoteId: 8, kind: StreamKind.AUDIO, expectedProducerId: 'producer-8' },
			2,
			abortController.signal,
		);
		let subscriptions: TRemoteMediaSubscriptions = new Map();
		subscriptions = markRemoteConsumeStarted(subscriptions, 8, StreamKind.AUDIO, 1, 'producer-8', 2).state;
		subscriptions = markRemoteProducerClosed(subscriptions, 8, StreamKind.AUDIO, 2, 'producer-8').state;

		publication.reconcile(subscriptions);

		expect(await published).toBe(false);
	});

	it('rejects a start superseded by a replacement producer before publication', async () => {
		const publication = createRemoteMediaConsumeStartPublication();
		const abortController = new AbortController();
		const published = publication.wait(
			{ remoteId: 9, kind: StreamKind.VIDEO, expectedProducerId: 'producer-old' },
			3,
			abortController.signal,
		);
		let subscriptions: TRemoteMediaSubscriptions = new Map();
		subscriptions = markRemoteConsumeStarted(subscriptions, 9, StreamKind.VIDEO, 1, 'producer-old', 3).state;
		subscriptions = markRemoteProducerPresent(subscriptions, 9, StreamKind.VIDEO, 2, 'producer-new').state;

		publication.reconcile(subscriptions);

		expect(await published).toBe(false);
	});
});
