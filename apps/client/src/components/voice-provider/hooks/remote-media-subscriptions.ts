import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import { useCallback, useMemo, useState } from 'react';
import {
	getPendingStreamKey,
	isExternalTrackPresent,
	type TExternalStreamTrackPresence,
	type TPendingStream,
} from './use-pending-streams';

export type TRemoteMediaStatus = 'available' | 'wanted' | 'consuming' | 'consumed' | 'failed';

export type TRemoteMediaSubscription = {
	key: string;
	remoteId: number;
	kind: StreamKind;
	producerPresent: boolean;
	producerId?: string;
	desired: boolean;
	status: TRemoteMediaStatus;
	consumerId?: string;
	updatedAt: number;
	pendingSince?: number;
	lastFailureAt?: number;
	lastFailureReason?: string;
};

export type TRemoteMediaSubscriptions = Map<string, TRemoteMediaSubscription>;

type TProducerSlot = {
	remoteId: number;
	kind: StreamKind;
	producerId?: string;
};

const isAutoDesiredKind = (kind: StreamKind) => kind === StreamKind.AUDIO;

const isUserStreamKind = (kind: StreamKind) =>
	kind === StreamKind.AUDIO ||
	kind === StreamKind.VIDEO ||
	kind === StreamKind.SCREEN ||
	kind === StreamKind.SCREEN_AUDIO;

const shouldKeepDesireOnProducerClose = (
	kind: StreamKind,
	subscription: TRemoteMediaSubscription,
	subscriptions: TRemoteMediaSubscriptions,
) => {
	if (kind === StreamKind.VIDEO) {
		return subscription.desired;
	}

	if (kind === StreamKind.SCREEN_AUDIO) {
		const screen = subscriptions.get(getPendingStreamKey(subscription.remoteId, StreamKind.SCREEN));

		return subscription.desired && screen?.desired === true && screen.producerPresent;
	}

	if (kind === StreamKind.EXTERNAL_AUDIO || kind === StreamKind.EXTERNAL_VIDEO) {
		return subscription.desired;
	}

	return false;
};

const getInitialStatus = (producerPresent: boolean, desired: boolean): TRemoteMediaStatus => {
	if (desired) {
		return producerPresent ? 'wanted' : 'failed';
	}

	return 'available';
};

const makeSubscription = (
	remoteId: number,
	kind: StreamKind,
	now: number,
	producerId?: string,
): TRemoteMediaSubscription => {
	const desired = isAutoDesiredKind(kind);

	return {
		key: getPendingStreamKey(remoteId, kind),
		remoteId,
		kind,
		producerPresent: true,
		producerId,
		desired,
		status: getInitialStatus(true, desired),
		updatedAt: now,
		pendingSince: now,
	};
};

const clone = (subscriptions: TRemoteMediaSubscriptions) => new Map(subscriptions);

// Reducers only publish a new map when a slot materially changed; otherwise
// they return the input map untouched, so snapshot reconciliation cannot dirty
// the ledger (and re-render every voice context consumer) with timestamp-only
// writes. updatedAt is deliberately excluded — it bumps only alongside a
// material change.
const isMateriallyEqual = (a: TRemoteMediaSubscription, b: TRemoteMediaSubscription) =>
	a.producerPresent === b.producerPresent &&
	a.producerId === b.producerId &&
	a.desired === b.desired &&
	a.status === b.status &&
	a.consumerId === b.consumerId &&
	a.pendingSince === b.pendingSince &&
	a.lastFailureAt === b.lastFailureAt &&
	a.lastFailureReason === b.lastFailureReason;

const applySlotUpdate = (
	subscriptions: TRemoteMediaSubscriptions,
	existing: TRemoteMediaSubscription | undefined,
	updated: TRemoteMediaSubscription,
	now: number,
): TRemoteMediaSubscriptions => {
	if (existing !== undefined && isMateriallyEqual(existing, updated)) {
		return subscriptions;
	}

	const next = clone(subscriptions);

	next.set(updated.key, { ...updated, updatedAt: now });

	return next;
};

export const markRemoteProducerPresent = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	producerId?: string,
): TRemoteMediaSubscriptions => {
	const existing = subscriptions.get(getPendingStreamKey(remoteId, kind));
	const base = existing ?? makeSubscription(remoteId, kind, now, producerId);
	const desired = base.desired || isAutoDesiredKind(kind);
	const status =
		base.status === 'consuming' || base.status === 'consumed' ? base.status : getInitialStatus(true, desired);

	return applySlotUpdate(
		subscriptions,
		existing,
		{
			...base,
			producerPresent: true,
			producerId: producerId ?? base.producerId,
			desired,
			status,
			pendingSince: status === 'consumed' ? undefined : (base.pendingSince ?? now),
		},
		now,
	);
};

export const markRemoteWatchRequested = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
): TRemoteMediaSubscriptions => {
	const existing = subscriptions.get(getPendingStreamKey(remoteId, kind));
	const base = existing ?? makeSubscription(remoteId, kind, now);

	return applySlotUpdate(
		subscriptions,
		existing,
		{
			...base,
			desired: true,
			status: base.status === 'consumed' ? 'consumed' : base.producerPresent ? 'wanted' : 'failed',
			pendingSince: base.status === 'consumed' ? undefined : (base.pendingSince ?? now),
		},
		now,
	);
};

export const markRemoteWatchStopped = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
): TRemoteMediaSubscriptions => {
	const existing = subscriptions.get(getPendingStreamKey(remoteId, kind));
	const base = existing ?? makeSubscription(remoteId, kind, now);

	return applySlotUpdate(
		subscriptions,
		existing,
		{
			...base,
			desired: false,
			status: 'available',
			consumerId: undefined,
			// Reset the pending age only when desire is actually being revoked so a
			// repeated stop-watch is a no-op rather than a ledger write.
			pendingSince: !base.producerPresent ? undefined : base.desired ? now : (base.pendingSince ?? now),
			lastFailureReason: undefined,
		},
		now,
	);
};

export const markRemoteConsumeStarted = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	producerId?: string,
): TRemoteMediaSubscriptions => {
	const next = markRemoteWatchRequested(
		markRemoteProducerPresent(subscriptions, remoteId, kind, now, producerId),
		remoteId,
		kind,
		now,
	);
	const existing = next.get(getPendingStreamKey(remoteId, kind));

	if (!existing) {
		return next;
	}

	return applySlotUpdate(
		next,
		existing,
		{
			...existing,
			status: 'consuming',
			producerId: producerId ?? existing.producerId,
			consumerId: undefined,
			pendingSince: existing.pendingSince ?? now,
			lastFailureReason: undefined,
			lastFailureAt: undefined,
		},
		now,
	);
};

export const markRemoteConsumeSucceeded = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	producerId: string,
	consumerId: string,
): TRemoteMediaSubscriptions => {
	const existing = subscriptions.get(getPendingStreamKey(remoteId, kind));
	const base = existing ?? makeSubscription(remoteId, kind, now, producerId);

	return applySlotUpdate(
		subscriptions,
		existing,
		{
			...base,
			producerPresent: true,
			producerId,
			desired: true,
			status: 'consumed',
			consumerId,
			pendingSince: undefined,
			lastFailureReason: undefined,
			lastFailureAt: undefined,
		},
		now,
	);
};

export const markRemoteConsumeFailed = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	reason?: string,
): TRemoteMediaSubscriptions => {
	const existing = subscriptions.get(getPendingStreamKey(remoteId, kind));
	const base = existing ?? makeSubscription(remoteId, kind, now);

	return applySlotUpdate(
		subscriptions,
		existing,
		{
			...base,
			desired: true,
			status: 'failed',
			consumerId: undefined,
			pendingSince: base.pendingSince ?? now,
			lastFailureAt: now,
			lastFailureReason: reason,
		},
		now,
	);
};

export const markRemoteProducerClosed = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	producerId?: string,
): TRemoteMediaSubscriptions => {
	const key = getPendingStreamKey(remoteId, kind);
	const existing = subscriptions.get(key);

	if (!existing) {
		return subscriptions;
	}

	if (producerId !== undefined && existing.producerId !== undefined && existing.producerId !== producerId) {
		return subscriptions;
	}

	const desired = shouldKeepDesireOnProducerClose(kind, existing, subscriptions);
	let next = applySlotUpdate(
		subscriptions,
		existing,
		{
			...existing,
			producerPresent: false,
			producerId: undefined,
			desired,
			status: desired ? 'failed' : 'available',
			consumerId: undefined,
			pendingSince: undefined,
		},
		now,
	);

	if (kind === StreamKind.SCREEN) {
		const audio = next.get(getPendingStreamKey(remoteId, StreamKind.SCREEN_AUDIO));

		// Only revoke screen-audio desire while it is actually held, so repeated
		// closes of an already-cleared screen stay no-ops.
		if (audio?.desired) {
			next = applySlotUpdate(
				next,
				audio,
				{
					...audio,
					desired: false,
					status: 'available',
					pendingSince: audio.producerPresent ? now : undefined,
				},
				now,
			);
		}
	}

	return next;
};

/**
 * Repairs the stranded-consumed shape: a consumer or its track died without a
 * matching ledger update (e.g. `trackended`/`transportclose` cleanup in
 * use-transports). Only a `consumed` slot is touched — `consuming` is owned by
 * an in-flight consume operation with its own retry and failure handling.
 * Flipping the slot back to a pending status re-enters it into the derived
 * pending map, so the stage card and the stale-stream repair pass can see it.
 */
export const markRemoteConsumerClosed = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	consumerId?: string,
): TRemoteMediaSubscriptions => {
	const key = getPendingStreamKey(remoteId, kind);
	const existing = subscriptions.get(key);

	if (!existing || existing.status !== 'consumed') {
		return subscriptions;
	}

	if (consumerId !== undefined && existing.consumerId !== undefined && existing.consumerId !== consumerId) {
		return subscriptions;
	}

	return applySlotUpdate(
		subscriptions,
		existing,
		{
			...existing,
			status: existing.desired ? (existing.producerPresent ? 'wanted' : 'failed') : 'available',
			consumerId: undefined,
			pendingSince: existing.producerPresent ? now : undefined,
		},
		now,
	);
};

export const clearRemoteMediaForUser = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
): TRemoteMediaSubscriptions => {
	let changed = false;
	const next = clone(subscriptions);

	next.forEach((subscription, key) => {
		if (subscription.remoteId === remoteId && isUserStreamKind(subscription.kind)) {
			next.delete(key);
			changed = true;
		}
	});

	return changed ? next : subscriptions;
};

export const clearRemoteMediaForExternalStream = (
	subscriptions: TRemoteMediaSubscriptions,
	streamId: number,
): TRemoteMediaSubscriptions => {
	let changed = false;
	const next = clone(subscriptions);

	next.forEach((subscription, key) => {
		if (
			subscription.remoteId === streamId &&
			(subscription.kind === StreamKind.EXTERNAL_AUDIO || subscription.kind === StreamKind.EXTERNAL_VIDEO)
		) {
			next.delete(key);
			changed = true;
		}
	});

	return changed ? next : subscriptions;
};

const producerSlotsFromSnapshot = (
	producers: TRemoteProducerIds,
	externalStreamTracks?: TExternalStreamTrackPresence,
): TProducerSlot[] => {
	const slots: TProducerSlot[] = [];

	(
		producers.remoteAudioProducers ?? producers.remoteAudioIds.map((remoteId) => ({ remoteId, producerId: undefined }))
	).forEach((producer) =>
		slots.push({ remoteId: producer.remoteId, kind: StreamKind.AUDIO, producerId: producer.producerId }),
	);
	(
		producers.remoteVideoProducers ?? producers.remoteVideoIds.map((remoteId) => ({ remoteId, producerId: undefined }))
	).forEach((producer) =>
		slots.push({ remoteId: producer.remoteId, kind: StreamKind.VIDEO, producerId: producer.producerId }),
	);
	(
		producers.remoteScreenProducers ??
		producers.remoteScreenIds.map((remoteId) => ({ remoteId, producerId: undefined }))
	).forEach((producer) =>
		slots.push({ remoteId: producer.remoteId, kind: StreamKind.SCREEN, producerId: producer.producerId }),
	);
	(
		producers.remoteScreenAudioProducers ??
		producers.remoteScreenAudioIds.map((remoteId) => ({ remoteId, producerId: undefined }))
	).forEach((producer) =>
		slots.push({ remoteId: producer.remoteId, kind: StreamKind.SCREEN_AUDIO, producerId: producer.producerId }),
	);

	const trackPresence = producers.externalStreamTracks ?? externalStreamTracks;
	const externalAudioProducers =
		producers.remoteExternalAudioProducers ??
		producers.remoteExternalStreamIds.flatMap((streamId) =>
			isExternalTrackPresent(trackPresence?.[streamId], 'audio') ? [{ streamId, producerId: undefined }] : [],
		);
	const externalVideoProducers =
		producers.remoteExternalVideoProducers ??
		producers.remoteExternalStreamIds.flatMap((streamId) =>
			isExternalTrackPresent(trackPresence?.[streamId], 'video') ? [{ streamId, producerId: undefined }] : [],
		);

	externalAudioProducers.forEach((producer) =>
		slots.push({ remoteId: producer.streamId, kind: StreamKind.EXTERNAL_AUDIO, producerId: producer.producerId }),
	);
	externalVideoProducers.forEach((producer) =>
		slots.push({ remoteId: producer.streamId, kind: StreamKind.EXTERNAL_VIDEO, producerId: producer.producerId }),
	);

	return slots;
};

export const reconcileRemoteMediaWithProducerSnapshot = (
	subscriptions: TRemoteMediaSubscriptions,
	producers: TRemoteProducerIds,
	externalStreamTracks: TExternalStreamTrackPresence | undefined,
	now: number,
): TRemoteMediaSubscriptions => {
	const slots = producerSlotsFromSnapshot(producers, externalStreamTracks);
	const activeKeys = new Set(slots.map((slot) => getPendingStreamKey(slot.remoteId, slot.kind)));
	let next = subscriptions;

	slots.forEach((slot) => {
		next = markRemoteProducerPresent(next, slot.remoteId, slot.kind, now, slot.producerId);
	});

	next.forEach((subscription) => {
		if (activeKeys.has(subscription.key)) {
			return;
		}

		next = markRemoteProducerClosed(next, subscription.remoteId, subscription.kind, now, subscription.producerId);
	});

	return next;
};

export const refreshRemoteMediaPendingAges = (
	subscriptions: TRemoteMediaSubscriptions,
	now: number,
): TRemoteMediaSubscriptions => {
	if (subscriptions.size === 0) {
		return subscriptions;
	}

	let changed = false;
	const next = new Map<string, TRemoteMediaSubscription>();

	subscriptions.forEach((subscription, key) => {
		// Refresh every non-consumed entry with a live producer — including
		// 'available' ones. Repair eligibility is decided by kind and watch state,
		// not status, so skipping a status would let an entry stuck in an
		// unexpected state re-arm the repair timer with zero delay.
		if (subscription.producerPresent && subscription.status !== 'consumed' && subscription.pendingSince !== now) {
			changed = true;
			next.set(key, { ...subscription, pendingSince: now, updatedAt: now });
		} else {
			next.set(key, subscription);
		}
	});

	return changed ? next : subscriptions;
};

export const remoteMediaSubscriptionsToPendingStreams = (
	subscriptions: TRemoteMediaSubscriptions,
): Map<string, TPendingStream> => {
	const pendingStreams = new Map<string, TPendingStream>();

	subscriptions.forEach((subscription, key) => {
		if (!subscription.producerPresent || subscription.status === 'consumed') {
			return;
		}

		pendingStreams.set(key, {
			remoteId: subscription.remoteId,
			kind: subscription.kind,
			createdAt: subscription.pendingSince ?? subscription.updatedAt,
			producerId: subscription.producerId,
		});
	});

	return pendingStreams;
};

const hasSubscriptionChanged = (prev: TRemoteMediaSubscriptions, next: TRemoteMediaSubscriptions): boolean => {
	if (prev === next) {
		return false;
	}

	if (prev.size !== next.size) {
		return true;
	}

	for (const [key, value] of next) {
		if (prev.get(key) !== value) {
			return true;
		}
	}

	return false;
};

export const useRemoteMediaSubscriptions = () => {
	const [remoteMediaSubscriptions, setRemoteMediaSubscriptions] = useState<TRemoteMediaSubscriptions>(() => new Map());
	const update = useCallback((nextFor: (prev: TRemoteMediaSubscriptions, now: number) => TRemoteMediaSubscriptions) => {
		setRemoteMediaSubscriptions((prev) => {
			const next = nextFor(prev, Date.now());

			return hasSubscriptionChanged(prev, next) ? next : prev;
		});
	}, []);
	const pendingStreams = useMemo(
		() => remoteMediaSubscriptionsToPendingStreams(remoteMediaSubscriptions),
		[remoteMediaSubscriptions],
	);
	const addPendingStream = useCallback(
		(remoteId: number, kind: StreamKind, producerId?: string) => {
			update((prev, now) => markRemoteProducerPresent(prev, remoteId, kind, now, producerId));
		},
		[update],
	);
	const removePendingStream = useCallback(
		(remoteId: number, kind: StreamKind, producerId?: string) => {
			update((prev, now) => markRemoteProducerClosed(prev, remoteId, kind, now, producerId));
		},
		[update],
	);
	const clearPendingStreamsForUser = useCallback(
		(remoteId: number) => {
			update((prev) => clearRemoteMediaForUser(prev, remoteId));
		},
		[update],
	);
	const clearAllPendingStreams = useCallback(() => {
		setRemoteMediaSubscriptions((prev) => (prev.size === 0 ? prev : new Map()));
	}, []);
	const reconcilePendingStreams = useCallback(
		(producers: TRemoteProducerIds, externalStreamTracks?: TExternalStreamTrackPresence) => {
			update((prev, now) => reconcileRemoteMediaWithProducerSnapshot(prev, producers, externalStreamTracks, now));
		},
		[update],
	);
	const refreshPendingStreamAges = useCallback(() => {
		update((prev, now) => refreshRemoteMediaPendingAges(prev, now));
	}, [update]);
	const markWatchRequested = useCallback(
		(remoteId: number, kind: StreamKind) => {
			update((prev, now) => markRemoteWatchRequested(prev, remoteId, kind, now));
		},
		[update],
	);
	const markWatchStopped = useCallback(
		(remoteId: number, kind: StreamKind) => {
			update((prev, now) => markRemoteWatchStopped(prev, remoteId, kind, now));
		},
		[update],
	);
	const markConsumeStarted = useCallback(
		(remoteId: number, kind: StreamKind, producerId?: string) => {
			update((prev, now) => markRemoteConsumeStarted(prev, remoteId, kind, now, producerId));
		},
		[update],
	);
	const markConsumeSucceeded = useCallback(
		(remoteId: number, kind: StreamKind, producerId: string, consumerId: string) => {
			update((prev, now) => markRemoteConsumeSucceeded(prev, remoteId, kind, now, producerId, consumerId));
		},
		[update],
	);
	const markConsumeFailed = useCallback(
		(remoteId: number, kind: StreamKind, reason?: string) => {
			update((prev, now) => markRemoteConsumeFailed(prev, remoteId, kind, now, reason));
		},
		[update],
	);
	const markConsumerClosed = useCallback(
		(remoteId: number, kind: StreamKind, consumerId?: string) => {
			update((prev, now) => markRemoteConsumerClosed(prev, remoteId, kind, now, consumerId));
		},
		[update],
	);
	const clearExternalStream = useCallback(
		(streamId: number) => {
			update((prev) => clearRemoteMediaForExternalStream(prev, streamId));
		},
		[update],
	);

	return {
		remoteMediaSubscriptions,
		pendingStreams,
		addPendingStream,
		removePendingStream,
		clearPendingStreamsForUser,
		clearAllPendingStreams,
		reconcilePendingStreams,
		refreshPendingStreamAges,
		markWatchRequested,
		markWatchStopped,
		markConsumeStarted,
		markConsumeSucceeded,
		markConsumeFailed,
		markConsumerClosed,
		clearExternalStream,
	};
};
