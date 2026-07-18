import { describe, expect, it } from 'bun:test';
import { StreamKind } from '@sharkord/shared';
import { getRemoteMediaRepairDelayMs, getRemoteMediaRepairIdentity } from '../hooks/remote-media-repair-policy';
import type { TRemoteMediaSubscriptions } from '../hooks/remote-media-subscriptions';

describe('remote media repair policy', () => {
	it('backs off three times and then exhausts the repair budget', () => {
		expect([0, 1, 2, 3].map(getRemoteMediaRepairDelayMs)).toEqual([15_000, 30_000, 60_000, undefined]);
	});

	it('keys the repair budget to channel and producer identity', () => {
		const key = `4-${StreamKind.AUDIO}`;
		const subscriptions: TRemoteMediaSubscriptions = new Map([
			[
				key,
				{
					key,
					remoteId: 4,
					kind: StreamKind.AUDIO,
					producerPresent: true,
					producerId: 'producer-a',
					desired: true,
					status: 'wanted',
					updatedAt: 100,
				},
			],
		]);
		const pendingStreams = new Map([
			[key, { remoteId: 4, kind: StreamKind.AUDIO, producerId: 'producer-a', createdAt: 100 }],
		]);

		expect(
			getRemoteMediaRepairIdentity({ channelId: 7, subscriptions, pendingStreams, currentExternalStreams: {} }),
		).toBe(`7|4:${StreamKind.AUDIO}:producer-a`);

		pendingStreams.set(key, {
			remoteId: 4,
			kind: StreamKind.AUDIO,
			producerId: 'producer-b',
			createdAt: 200,
		});
		expect(
			getRemoteMediaRepairIdentity({ channelId: 7, subscriptions, pendingStreams, currentExternalStreams: {} }),
		).toBe(`7|4:${StreamKind.AUDIO}:producer-b`);
	});

	it('excludes watch-on-demand video from automatic repair identity', () => {
		const pendingStreams = new Map([
			[`4-${StreamKind.VIDEO}`, { remoteId: 4, kind: StreamKind.VIDEO, producerId: 'video', createdAt: 100 }],
		]);

		expect(
			getRemoteMediaRepairIdentity({
				channelId: 7,
				subscriptions: new Map(),
				pendingStreams,
				currentExternalStreams: {},
			}),
		).toBeUndefined();
	});
});
