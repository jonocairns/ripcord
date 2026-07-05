import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import { useCallback, useMemo, useState } from 'react';
import { getPendingStreamKey, type TExternalStreamTrackPresence, type TPendingStream } from './use-pending-streams';

export type TRemoteMediaStatus = 'available' | 'wanted' | 'consuming' | 'consumed' | 'retrying' | 'failed' | 'closing';

export type TRemoteMediaSubscription = {
	key: string;
	remoteId: number;
	kind: StreamKind;
	producerPresent: boolean;
	producerId?: string;
	desired: boolean;
	status: TRemoteMediaStatus;
	consumerId?: string;
	consumeGeneration: number;
	updatedAt: number;
	pendingSince?: number;
	retryAttempt: number;
	nextRetryAt?: number;
	lastFailureAt?: number;
	lastFailureReason?: string;
	lastRepairAt?: number;
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

	return producerPresent ? 'available' : 'available';
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
		consumeGeneration: 0,
		updatedAt: now,
		pendingSince: now,
		retryAttempt: 0,
	};
};

const clone = (subscriptions: TRemoteMediaSubscriptions) => new Map(subscriptions);

const withSlot = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	producerId?: string,
) => {
	const key = getPendingStreamKey(remoteId, kind);
	const existing = subscriptions.get(key);

	if (existing) {
		return existing;
	}

	const subscription = makeSubscription(remoteId, kind, now, producerId);
	subscriptions.set(key, subscription);

	return subscription;
};

export const markRemoteProducerPresent = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	producerId?: string,
): TRemoteMediaSubscriptions => {
	const next = clone(subscriptions);
	const existing = withSlot(next, remoteId, kind, now, producerId);
	const desired = existing.desired || isAutoDesiredKind(kind);
	const status =
		existing.status === 'consuming' || existing.status === 'consumed' || existing.status === 'retrying'
			? existing.status
			: getInitialStatus(true, desired);

	next.set(existing.key, {
		...existing,
		producerPresent: true,
		producerId: producerId ?? existing.producerId,
		desired,
		status,
		updatedAt: now,
		pendingSince: status === 'consumed' ? undefined : (existing.pendingSince ?? now),
	});

	return next;
};

export const markRemoteWatchRequested = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
): TRemoteMediaSubscriptions => {
	const next = clone(subscriptions);
	const existing = withSlot(next, remoteId, kind, now);

	next.set(existing.key, {
		...existing,
		desired: true,
		status: existing.status === 'consumed' ? 'consumed' : existing.producerPresent ? 'wanted' : 'failed',
		updatedAt: now,
		pendingSince: existing.status === 'consumed' ? undefined : (existing.pendingSince ?? now),
	});

	return next;
};

export const markRemoteWatchStopped = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
): TRemoteMediaSubscriptions => {
	const next = clone(subscriptions);
	const existing = withSlot(next, remoteId, kind, now);

	next.set(existing.key, {
		...existing,
		desired: false,
		status: existing.producerPresent ? 'available' : 'available',
		consumerId: undefined,
		updatedAt: now,
		pendingSince: existing.producerPresent ? now : undefined,
		retryAttempt: 0,
		nextRetryAt: undefined,
		lastFailureReason: undefined,
	});

	return next;
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
	const key = getPendingStreamKey(remoteId, kind);
	const existing = next.get(key);

	if (!existing) {
		return next;
	}

	next.set(key, {
		...existing,
		status: 'consuming',
		producerId: producerId ?? existing.producerId,
		consumerId: undefined,
		consumeGeneration: existing.consumeGeneration + 1,
		updatedAt: now,
		pendingSince: existing.pendingSince ?? now,
		lastFailureReason: undefined,
		lastFailureAt: undefined,
	});

	return next;
};

export const markRemoteConsumeSucceeded = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	producerId: string,
	consumerId: string,
): TRemoteMediaSubscriptions => {
	const next = clone(subscriptions);
	const existing = withSlot(next, remoteId, kind, now, producerId);

	next.set(existing.key, {
		...existing,
		producerPresent: true,
		producerId,
		desired: true,
		status: 'consumed',
		consumerId,
		updatedAt: now,
		pendingSince: undefined,
		retryAttempt: 0,
		nextRetryAt: undefined,
		lastFailureReason: undefined,
		lastFailureAt: undefined,
	});

	return next;
};

export const markRemoteConsumeFailed = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	reason?: string,
): TRemoteMediaSubscriptions => {
	const next = clone(subscriptions);
	const existing = withSlot(next, remoteId, kind, now);

	next.set(existing.key, {
		...existing,
		desired: true,
		status: 'failed',
		consumerId: undefined,
		updatedAt: now,
		pendingSince: existing.pendingSince ?? now,
		lastFailureAt: now,
		lastFailureReason: reason,
	});

	return next;
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

	const next = clone(subscriptions);
	const desired = shouldKeepDesireOnProducerClose(kind, existing, subscriptions);

	next.set(key, {
		...existing,
		producerPresent: false,
		producerId: undefined,
		desired,
		status: desired ? 'failed' : 'available',
		consumerId: undefined,
		updatedAt: now,
		pendingSince: undefined,
	});

	if (kind === StreamKind.SCREEN) {
		const audioKey = getPendingStreamKey(remoteId, StreamKind.SCREEN_AUDIO);
		const audio = next.get(audioKey);

		if (audio) {
			next.set(audioKey, {
				...audio,
				desired: false,
				status: audio.producerPresent ? 'available' : 'available',
				updatedAt: now,
				pendingSince: audio.producerPresent ? now : undefined,
			});
		}
	}

	return next;
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
		producers.remoteExternalStreamIds.flatMap((streamId) => {
			const tracks = trackPresence?.[streamId];

			return tracks === undefined || tracks.audio !== false ? [{ streamId, producerId: undefined }] : [];
		});
	const externalVideoProducers =
		producers.remoteExternalVideoProducers ??
		producers.remoteExternalStreamIds.flatMap((streamId) => {
			const tracks = trackPresence?.[streamId];

			return tracks === undefined || tracks.video !== false ? [{ streamId, producerId: undefined }] : [];
		});

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

	const next = new Map<string, TRemoteMediaSubscription>();

	subscriptions.forEach((subscription, key) => {
		next.set(key, {
			...subscription,
			pendingSince:
				subscription.producerPresent && subscription.status !== 'consumed' && subscription.status !== 'available'
					? now
					: subscription.pendingSince,
			lastRepairAt: now,
		});
	});

	return next;
};

export const remoteMediaSubscriptionsToPendingStreams = (
	subscriptions: TRemoteMediaSubscriptions,
): Map<string, TPendingStream> => {
	const pendingStreams = new Map<string, TPendingStream>();

	subscriptions.forEach((subscription, key) => {
		if (!subscription.producerPresent || subscription.status === 'consumed' || subscription.status === 'closing') {
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
		clearExternalStream,
	};
};
