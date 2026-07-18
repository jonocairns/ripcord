import { describe, expect, it } from 'bun:test';
import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import { runRemoteMediaProducerRepair, type TRemoteMediaProducerRepairPorts } from '../remote-media-producer-repair';
import type { TRemoteMediaRepairIdentity } from '../remote-media-subscriptions';

const makeProducers = (overrides: Partial<TRemoteProducerIds> = {}): TRemoteProducerIds => ({
	remoteAudioIds: [],
	remoteVideoIds: [],
	remoteScreenIds: [],
	remoteScreenAudioIds: [],
	remoteExternalStreamIds: [],
	...overrides,
});

const makeIdentity = (remoteId: number, producerId: string, channelId = 7): TRemoteMediaRepairIdentity => ({
	channelId,
	key: `${remoteId}-${StreamKind.AUDIO}`,
	remoteId,
	kind: StreamKind.AUDIO,
	producerId,
});

const createDeferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});

	return { promise, resolve };
};

describe('remote media producer repair', () => {
	it('consumes only the exact producer that owns the repair attempt', async () => {
		const identity = makeIdentity(1, 'producer-1');
		const consumed: TRemoteMediaRepairIdentity[] = [];
		const present: string[] = [];
		const missing: string[] = [];
		const ports: TRemoteMediaProducerRepairPorts = {
			getProducers: async () =>
				makeProducers({
					remoteAudioIds: [1, 2],
					remoteAudioProducers: [
						{ remoteId: 1, producerId: 'producer-1' },
						{ remoteId: 2, producerId: 'producer-2' },
					],
				}),
			isIdentityCurrent: () => true,
			markProducerMissing: (repairIdentity) => missing.push(repairIdentity.key),
			markProducerPresent: (_repairIdentity, producerId) => present.push(producerId ?? 'unknown'),
			consume: async (repairIdentity) => {
				consumed.push(repairIdentity);
			},
		};

		expect(await runRemoteMediaProducerRepair(identity, undefined, ports)).toBe('completed');
		expect(consumed).toEqual([identity]);
		expect(present).toEqual([]);
		expect(missing).toEqual([]);
	});

	it('invalidates stale in-flight work while another producer completes independently', async () => {
		const firstIdentity = makeIdentity(1, 'producer-1-old');
		const secondIdentity = makeIdentity(2, 'producer-2');
		const firstSnapshot = createDeferred<TRemoteProducerIds>();
		const secondSnapshot = createDeferred<TRemoteProducerIds>();
		const currentProducerIds = new Map([
			[firstIdentity.key, firstIdentity.producerId],
			[secondIdentity.key, secondIdentity.producerId],
		]);
		const consumed: string[] = [];
		const present: string[] = [];
		const missing: string[] = [];
		const portsFor = (
			deferredSnapshot: ReturnType<typeof createDeferred<TRemoteProducerIds>>,
		): TRemoteMediaProducerRepairPorts => ({
			getProducers: () => deferredSnapshot.promise,
			isIdentityCurrent: (identity) => currentProducerIds.get(identity.key) === identity.producerId,
			markProducerMissing: (identity) => missing.push(identity.key),
			markProducerPresent: (identity) => present.push(identity.key),
			consume: async (identity) => {
				consumed.push(identity.key);
			},
		});

		const firstRepair = runRemoteMediaProducerRepair(firstIdentity, undefined, portsFor(firstSnapshot));
		const secondRepair = runRemoteMediaProducerRepair(secondIdentity, undefined, portsFor(secondSnapshot));

		currentProducerIds.set(firstIdentity.key, 'producer-1-new');
		firstSnapshot.resolve(
			makeProducers({
				remoteAudioIds: [1],
				remoteAudioProducers: [{ remoteId: 1, producerId: 'producer-1-old' }],
			}),
		);
		secondSnapshot.resolve(
			makeProducers({
				remoteAudioIds: [2],
				remoteAudioProducers: [{ remoteId: 2, producerId: 'producer-2' }],
			}),
		);

		expect(await firstRepair).toBe('superseded');
		expect(await secondRepair).toBe('completed');
		expect(consumed).toEqual([secondIdentity.key]);
		expect(present).toEqual([]);
		expect(missing).toEqual([]);
	});

	it('reconciles a replacement identity without consuming the stale producer', async () => {
		const identity = makeIdentity(1, 'producer-old');
		const replacements: Array<{ key: string; producerId?: string }> = [];
		const consumed: string[] = [];
		const ports: TRemoteMediaProducerRepairPorts = {
			getProducers: async () =>
				makeProducers({
					remoteAudioIds: [1],
					remoteAudioProducers: [{ remoteId: 1, producerId: 'producer-new' }],
				}),
			isIdentityCurrent: () => true,
			markProducerMissing: () => {
				throw new Error('Producer should be present');
			},
			markProducerPresent: (repairIdentity, producerId) => {
				replacements.push({ key: repairIdentity.key, producerId });
			},
			consume: async (repairIdentity) => {
				consumed.push(repairIdentity.key);
			},
		};

		expect(await runRemoteMediaProducerRepair(identity, undefined, ports)).toBe('replaced');
		expect(replacements).toEqual([{ key: identity.key, producerId: 'producer-new' }]);
		expect(consumed).toEqual([]);
	});

	it('keeps a known local identity when an older server snapshot only reports slot presence', async () => {
		const identity = makeIdentity(1, 'producer-1');
		const consumed: string[] = [];
		const ports: TRemoteMediaProducerRepairPorts = {
			getProducers: async () => makeProducers({ remoteAudioIds: [1] }),
			isIdentityCurrent: () => true,
			markProducerMissing: () => {
				throw new Error('Producer should be present');
			},
			markProducerPresent: () => {
				throw new Error('Legacy presence should not replace a known identity');
			},
			consume: async (repairIdentity) => {
				consumed.push(repairIdentity.key);
			},
		};

		expect(await runRemoteMediaProducerRepair(identity, undefined, ports)).toBe('completed');
		expect(consumed).toEqual([identity.key]);
	});

	it('invalidates work when the channel changes before the producer snapshot returns', async () => {
		const identity = makeIdentity(1, 'producer-1');
		const snapshot = createDeferred<TRemoteProducerIds>();
		let currentChannelId = identity.channelId;
		let mutated = false;
		const ports: TRemoteMediaProducerRepairPorts = {
			getProducers: () => snapshot.promise,
			isIdentityCurrent: (repairIdentity) => repairIdentity.channelId === currentChannelId,
			markProducerMissing: () => {
				mutated = true;
			},
			markProducerPresent: () => {
				mutated = true;
			},
			consume: async () => {
				mutated = true;
			},
		};

		const repair = runRemoteMediaProducerRepair(identity, undefined, ports);
		currentChannelId += 1;
		snapshot.resolve(
			makeProducers({
				remoteAudioIds: [1],
				remoteAudioProducers: [{ remoteId: 1, producerId: 'producer-1' }],
			}),
		);

		expect(await repair).toBe('superseded');
		expect(mutated).toBe(false);
	});
});
