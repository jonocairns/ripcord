/**
 * Regression guard for the stale existing-producers sweep race.
 *
 * runConsumeExistingProducersSweep (use-transports.ts) is a useCallback deep in
 * a React component that can't be rendered without a full browser environment,
 * so — following recover-transport-session.test.ts in this tree — we reproduce
 * only its guarded control-flow here. Everything that matters for the assertion
 * is the REAL module: the ledger reducers and the consume-operation generation.
 * Keep this skeleton structurally identical to the real sweep so a change to the
 * guard surfaces here.
 *
 * The race: a sweep fetches a producer snapshot, then cleanupTransports() (via
 * resetConsumeOperationGeneration) tears down and rebuilds the session while the
 * snapshot is in flight. If the now-stale snapshot is applied to the rebuilt
 * ledger, reconcile marks legitimate new-session producers absent
 * (producerPresent: false). Such a slot drops out of pendingStreams, so the
 * repair runner never reschedules it and the bad state sticks.
 */

import { describe, expect, it } from 'bun:test';
import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import {
	createConsumeOperationState,
	resetConsumeOperationGeneration,
	type TConsumeOperationState,
} from '../consume-operation-state';
import {
	markRemoteProducerPresent,
	markRemoteWatchRequested,
	reconcileRemoteMediaWithProducerSnapshot,
	remoteMediaSubscriptionsToPendingStreams,
	type TRemoteMediaSubscriptions,
} from '../remote-media-subscriptions';
import { getPendingStreamKey } from '../use-pending-streams';

const emptySnapshot = (): TRemoteProducerIds => ({
	remoteAudioIds: [],
	remoteVideoIds: [],
	remoteScreenIds: [],
	remoteScreenAudioIds: [],
	remoteExternalStreamIds: [],
});

// A rebuilt-session ledger already holding one live, watched remote camera.
const rebuiltLedgerWithLiveVideo = (remoteId: number): TRemoteMediaSubscriptions => {
	let ledger: TRemoteMediaSubscriptions = new Map();
	ledger = markRemoteProducerPresent(ledger, remoteId, StreamKind.VIDEO, 1, `producer-${remoteId}`).state;
	ledger = markRemoteWatchRequested(ledger, remoteId, StreamKind.VIDEO, 1).state;
	return ledger;
};

// Mirrors runConsumeExistingProducersSweep's guard: stamp the generation at
// entry and bail after each async boundary if a cleanup bumped it before the
// ledger-mutating tail runs.
const runGuardedSweep = async (
	consumeState: TConsumeOperationState,
	getProducers: () => Promise<TRemoteProducerIds>,
	ledgerRef: { current: TRemoteMediaSubscriptions },
	now: number,
): Promise<'applied' | 'discarded'> => {
	const sweepGeneration = consumeState.generation;
	const isSuperseded = () => consumeState.generation !== sweepGeneration;

	const producers = await getProducers();
	if (isSuperseded()) {
		return 'discarded';
	}

	// (the real sweep consumes audio here; omitted — it has no bearing on the
	// reconcile-tail write this test guards)
	if (isSuperseded()) {
		return 'discarded';
	}

	ledgerRef.current = reconcileRemoteMediaWithProducerSnapshot(ledgerRef.current, producers, undefined, now).state;
	return 'applied';
};

describe('existing producers sweep generation guard', () => {
	it('discards a snapshot whose generation was bumped by cleanup mid-flight', async () => {
		const consumeState = createConsumeOperationState();
		const ledgerRef = { current: rebuiltLedgerWithLiveVideo(5) };
		const videoKey = getPendingStreamKey(5, StreamKind.VIDEO);

		let resolveSnapshot!: (snapshot: TRemoteProducerIds) => void;
		const snapshotPromise = new Promise<TRemoteProducerIds>((resolve) => {
			resolveSnapshot = resolve;
		});

		const sweep = runGuardedSweep(consumeState, () => snapshotPromise, ledgerRef, 2);

		// cleanupTransports() lands while the snapshot is in flight.
		resetConsumeOperationGeneration(consumeState);

		// The stale snapshot describes the old session and omits user 5.
		resolveSnapshot(emptySnapshot());

		expect(await sweep).toBe('discarded');
		// The rebuilt session's live camera is untouched — not flipped absent.
		expect(ledgerRef.current.get(videoKey)?.producerPresent).toBe(true);
	});

	it('demonstrates the damage the guard prevents when the generation is unchanged', async () => {
		const consumeState = createConsumeOperationState();
		const ledgerRef = { current: rebuiltLedgerWithLiveVideo(5) };
		const videoKey = getPendingStreamKey(5, StreamKind.VIDEO);

		// No cleanup interleaves: the stale snapshot is applied as-is.
		expect(await runGuardedSweep(consumeState, async () => emptySnapshot(), ledgerRef, 2)).toBe('applied');

		const slot = ledgerRef.current.get(videoKey);
		// The live camera is wrongly marked absent and stuck 'failed'...
		expect(slot?.producerPresent).toBe(false);
		expect(slot?.status).toBe('failed');
		// ...and, being producer-absent, it is invisible to the repair runner,
		// which only ever derives its schedule from pendingStreams.
		expect(remoteMediaSubscriptionsToPendingStreams(ledgerRef.current).has(videoKey)).toBe(false);
	});
});
