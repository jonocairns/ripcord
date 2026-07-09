import { StreamKind, type TRemoteProducerIds } from '@sharkord/shared';
import { useCallback, useMemo, useState } from 'react';
import {
	getOldestRepairEligiblePendingCreatedAt,
	getPendingStreamKey,
	isExternalTrackPresent,
	PENDING_STREAM_REPAIR_AGE_MS,
	type TExternalStreamTrackPresence,
	type TPendingStream,
} from './use-pending-streams';

export type TRemoteMediaStatus = 'available' | 'wanted' | 'consuming' | 'retrying' | 'consumed' | 'failed';

export type TVisibleRemoteMediaStatus = 'live' | 'pending' | 'retrying' | 'failed' | 'closing';

export type TRemoteMediaSubscription = {
	key: string;
	remoteId: number;
	kind: StreamKind;
	producerPresent: boolean;
	producerId?: string;
	desired: boolean;
	status: TRemoteMediaStatus;
	consumerId?: string;
	consumeGeneration?: number;
	updatedAt: number;
	pendingSince?: number;
	lastFailureAt?: number;
	lastFailureReason?: string;
};

export type TRemoteMediaSubscriptions = Map<string, TRemoteMediaSubscription>;

export type TVisibleRemoteMedia = {
	key: string;
	remoteId: number;
	kind: StreamKind;
	status: TVisibleRemoteMediaStatus;
	subscriptionStatus: TRemoteMediaStatus;
	producerPresent: boolean;
	desired: boolean;
	producerId?: string;
};

export type TStreamsToConsumeCommand = {
	type: 'consume';
	key: string;
	remoteId: number;
	kind: StreamKind;
	producerId?: string;
	generation: number;
	isManualRetry?: boolean;
};

export type TCloseConsumerCommand = {
	type: 'closeConsumer';
	key: string;
	remoteId: number;
	kind: StreamKind;
	consumerId?: string;
	generation?: number;
};

export type TScheduleRetryCommand = {
	type: 'scheduleRetry';
	key: string;
	retryAt: number;
	generation?: number;
};

export type TRemoteMediaCommand = TStreamsToConsumeCommand | TCloseConsumerCommand | TScheduleRetryCommand;

export type TRemoteMediaReducerResult = {
	state: TRemoteMediaSubscriptions;
	commands: TRemoteMediaCommand[];
};

type TRemoteMediaCommandContext = {
	externalStreamTracks?: TExternalStreamTrackPresence;
};

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

const isExternalStreamKind = (kind: StreamKind) =>
	kind === StreamKind.EXTERNAL_AUDIO || kind === StreamKind.EXTERNAL_VIDEO;

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

// Screen-audio desire is subordinate to the screen's: accepting the screen
// implies wanting its audio, and audio can appear after the screen is already
// watched. This is the grant-side mirror of shouldKeepDesireOnProducerClose —
// both sides now share one predicate so screen-audio intent can never drift.
const inheritsScreenAudioDesire = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
): boolean => {
	if (kind !== StreamKind.SCREEN_AUDIO) {
		return false;
	}

	const screen = subscriptions.get(getPendingStreamKey(remoteId, StreamKind.SCREEN));

	return screen?.desired === true && screen.producerPresent === true;
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

export const remoteMediaState = (result: TRemoteMediaReducerResult): TRemoteMediaSubscriptions => result.state;

const emptyResult = (state: TRemoteMediaSubscriptions): TRemoteMediaReducerResult => ({
	state,
	commands: [],
});

const nextConsumeGeneration = (subscription: TRemoteMediaSubscription): number =>
	(subscription.consumeGeneration ?? 0) + 1;

const canConsumeExternalStream = (
	subscription: TRemoteMediaSubscription,
	externalStreamTracks: TExternalStreamTrackPresence | undefined,
): boolean => {
	const tracks = externalStreamTracks?.[subscription.remoteId];

	if (tracks === undefined) {
		return false;
	}

	if (subscription.kind === StreamKind.EXTERNAL_AUDIO) {
		return isExternalTrackPresent(tracks, 'audio');
	}

	if (subscription.kind === StreamKind.EXTERNAL_VIDEO) {
		return isExternalTrackPresent(tracks, 'video');
	}

	return true;
};

const canConsumeScreenAudio = (
	subscription: TRemoteMediaSubscription,
	subscriptions: TRemoteMediaSubscriptions,
): boolean => {
	if (subscription.kind !== StreamKind.SCREEN_AUDIO) {
		return true;
	}

	const screen = subscriptions.get(getPendingStreamKey(subscription.remoteId, StreamKind.SCREEN));

	return screen?.desired === true && screen.producerPresent;
};

// The single source of truth for "may this slot be consumed right now": the
// producer is live, the user still wants it, it is in the state this consume was
// minted for (wanted, or retrying for a manual retry), and any external/screen-
// audio preconditions hold. Both command minting (toConsumeCommand) and the
// runner's drain-time revalidation (isConsumeCommandRunnable) go through here so
// a queued consume can never outlive the intent that produced it.
const isSubscriptionConsumeEligible = (
	subscription: TRemoteMediaSubscription,
	subscriptions: TRemoteMediaSubscriptions,
	context: TRemoteMediaCommandContext | undefined,
	isManualRetry: boolean,
): boolean =>
	subscription.producerPresent &&
	subscription.desired &&
	(isManualRetry ? subscription.status === 'retrying' : subscription.status === 'wanted') &&
	!(
		isExternalStreamKind(subscription.kind) && !canConsumeExternalStream(subscription, context?.externalStreamTracks)
	) &&
	canConsumeScreenAudio(subscription, subscriptions);

const toConsumeCommand = (
	subscription: TRemoteMediaSubscription,
	subscriptions: TRemoteMediaSubscriptions,
	context?: TRemoteMediaCommandContext,
	isManualRetry = false,
): TStreamsToConsumeCommand | undefined => {
	if (!isSubscriptionConsumeEligible(subscription, subscriptions, context, isManualRetry)) {
		return undefined;
	}

	return {
		type: 'consume',
		key: subscription.key,
		remoteId: subscription.remoteId,
		kind: subscription.kind,
		producerId: subscription.producerId,
		generation: nextConsumeGeneration(subscription),
		isManualRetry: isManualRetry || undefined,
	};
};

const maybeConsumeCommand = (
	subscriptions: TRemoteMediaSubscriptions,
	key: string,
	context?: TRemoteMediaCommandContext,
): TStreamsToConsumeCommand[] => {
	const subscription = subscriptions.get(key);
	const command = subscription ? toConsumeCommand(subscription, subscriptions, context) : undefined;

	return command ? [command] : [];
};

// Revalidates a queued consume command against the live ledger just before the
// runner executes it. A consume can sit in the queue while rtpCapabilities is
// null (no runner) and outlive its intent — e.g. the user stops watching, which
// flips the slot to desired:false/status:'available'. Running the stale command
// would call markRemoteConsumeStarted, re-request the watch, and resurrect media
// the user explicitly stopped, so the runner drops any command whose slot is no
// longer consume-eligible.
export const isConsumeCommandRunnable = (
	subscriptions: TRemoteMediaSubscriptions,
	command: TStreamsToConsumeCommand,
	externalStreamTracks?: TExternalStreamTrackPresence,
): boolean => {
	const subscription = subscriptions.get(command.key);

	if (subscription === undefined) {
		return false;
	}

	// Drop a command minted for a now-superseded producer. The server consume
	// route resolves the producer itself (expectedProducerId is client-only), but
	// running a stale command still flows its old producerId through
	// markRemoteConsumeStarted -> markRemoteProducerPresent, whose producer-
	// replaced branch would re-stamp the ledger with the dead id and tear down the
	// live consumer before the server's real id lands on success. Mirrors the
	// "both known and differ" producer-mismatch guard used across the reducers.
	if (
		command.producerId !== undefined &&
		subscription.producerId !== undefined &&
		command.producerId !== subscription.producerId
	) {
		return false;
	}

	return isSubscriptionConsumeEligible(
		subscription,
		subscriptions,
		{ externalStreamTracks },
		command.isManualRetry === true,
	);
};

const closeConsumerCommandFor = (
	subscription: TRemoteMediaSubscription,
	consumerId = subscription.consumerId,
): TCloseConsumerCommand | undefined => {
	if (consumerId === undefined) {
		return undefined;
	}

	return {
		type: 'closeConsumer',
		key: subscription.key,
		remoteId: subscription.remoteId,
		kind: subscription.kind,
		consumerId,
		generation: subscription.consumeGeneration,
	};
};

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
	a.consumeGeneration === b.consumeGeneration &&
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
	context?: TRemoteMediaCommandContext,
): TRemoteMediaReducerResult => {
	const existing = subscriptions.get(getPendingStreamKey(remoteId, kind));
	const base = existing ?? makeSubscription(remoteId, kind, now, producerId);
	const desired = base.desired || isAutoDesiredKind(kind) || inheritsScreenAudioDesire(subscriptions, remoteId, kind);
	// A snapshot reporting a different producerId for the same slot means the
	// producer was replaced without a matching close event (reconnect/repair).
	// Preserving consumed/consuming/retrying here would strand the slot on a dead
	// consumer and hide the new producer from the pending map, so treat the slot
	// as fresh and tear down the stale consumer.
	const producerReplaced = producerId !== undefined && base.producerId !== undefined && base.producerId !== producerId;
	const status =
		!producerReplaced && (base.status === 'consuming' || base.status === 'retrying' || base.status === 'consumed')
			? base.status
			: getInitialStatus(true, desired);
	const replacedCloseCommand = producerReplaced ? closeConsumerCommandFor(base) : undefined;

	const state = applySlotUpdate(
		subscriptions,
		existing,
		{
			...base,
			producerPresent: true,
			producerId: producerId ?? base.producerId,
			consumerId: producerReplaced ? undefined : base.consumerId,
			consumeGeneration: producerReplaced ? undefined : base.consumeGeneration,
			desired,
			status,
			pendingSince: status === 'consumed' ? undefined : (base.pendingSince ?? now),
		},
		now,
	);

	return {
		state,
		commands: [
			...(replacedCloseCommand ? [replacedCloseCommand] : []),
			...maybeConsumeCommand(state, base.key, context),
		],
	};
};

export const markRemoteWatchRequested = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	context?: TRemoteMediaCommandContext,
): TRemoteMediaReducerResult => {
	const existing = subscriptions.get(getPendingStreamKey(remoteId, kind));
	const base = existing ?? makeSubscription(remoteId, kind, now);

	let next = applySlotUpdate(
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
	const commands: TRemoteMediaCommand[] = [];

	// Only cascade when an audio slot already exists (its producer is/was
	// present). Intent-ahead-of-producer is handled by inheritsScreenAudioDesire
	// in markRemoteProducerPresent, so this branch never fabricates a phantom
	// producerPresent=true SCREEN_AUDIO slot.
	if (kind === StreamKind.SCREEN && subscriptions.has(getPendingStreamKey(remoteId, StreamKind.SCREEN_AUDIO))) {
		const result = markRemoteWatchRequested(next, remoteId, StreamKind.SCREEN_AUDIO, now, context);
		next = result.state;
		commands.push(...result.commands);
	}
	commands.push(...maybeConsumeCommand(next, base.key, context));

	return {
		state: next,
		commands,
	};
};

export const markRemoteWatchStopped = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
): TRemoteMediaReducerResult => {
	const existing = subscriptions.get(getPendingStreamKey(remoteId, kind));
	const base = existing ?? makeSubscription(remoteId, kind, now);
	const closeCommand = closeConsumerCommandFor(base);

	let next = applySlotUpdate(
		subscriptions,
		existing,
		{
			...base,
			desired: false,
			status: 'available',
			consumerId: undefined,
			consumeGeneration: undefined,
			// Reset the pending age only when desire is actually being revoked so a
			// repeated stop-watch is a no-op rather than a ledger write.
			pendingSince: !base.producerPresent ? undefined : base.desired ? now : (base.pendingSince ?? now),
			lastFailureReason: undefined,
		},
		now,
	);
	const commands: TRemoteMediaCommand[] = closeCommand ? [closeCommand] : [];

	// Revoke screen-audio desire alongside the screen. Guarded by slot existence
	// for the same reason as the grant cascade — an unconditional recurse would
	// makeSubscription a phantom producerPresent=true SCREEN_AUDIO slot.
	if (kind === StreamKind.SCREEN && subscriptions.has(getPendingStreamKey(remoteId, StreamKind.SCREEN_AUDIO))) {
		const result = markRemoteWatchStopped(next, remoteId, StreamKind.SCREEN_AUDIO, now);
		next = result.state;
		commands.push(...result.commands);
	}

	return {
		state: next,
		commands,
	};
};

export const markRemoteRetryRequested = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	context?: TRemoteMediaCommandContext,
): TRemoteMediaReducerResult => {
	const key = getPendingStreamKey(remoteId, kind);
	const existing = subscriptions.get(key);

	if (!existing || !existing.producerPresent || !existing.desired) {
		return emptyResult(subscriptions);
	}

	const retrying = applySlotUpdate(
		subscriptions,
		existing,
		{
			...existing,
			status: 'retrying',
			consumerId: undefined,
			pendingSince: existing.pendingSince ?? now,
			lastFailureReason: undefined,
			lastFailureAt: undefined,
		},
		now,
	);
	const updated = retrying.get(key);
	const command = updated ? toConsumeCommand(updated, retrying, context, true) : undefined;

	return {
		state: retrying,
		commands: command ? [command] : [],
	};
};

export const markRemoteConsumeStarted = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	producerId?: string,
	consumeGeneration?: number,
	isManualRetry = false,
): TRemoteMediaReducerResult => {
	const key = getPendingStreamKey(remoteId, kind);
	const presentResult = markRemoteProducerPresent(subscriptions, remoteId, kind, now, producerId);
	const watchResult = markRemoteWatchRequested(presentResult.state, remoteId, kind, now);
	const next = watchResult.state;
	// Preserve commands the present/watch cascade emitted for *other* slots — most
	// importantly, starting a SCREEN consume discovers its SCREEN_AUDIO slot and
	// enqueues that consume. A direct restore (`consume(remoteId, SCREEN)` on
	// reconnect) never calls markWatchRequested, so this cascade is the only place
	// the screen-audio consume is minted; dropping it stranded restored screen
	// audio until repair. The command for the slot we are starting here is dropped:
	// its consume is already in flight (this call), and the runner revalidates any
	// preserved command against the live ledger, so a redundant cross-slot consume
	// for an already-consuming slot is skipped rather than re-run.
	const cascadedCommands = [...presentResult.commands, ...watchResult.commands].filter(
		(command) => command.key !== key,
	);
	const existing = next.get(key);

	if (!existing) {
		return { state: next, commands: cascadedCommands };
	}

	const closeCommand = closeConsumerCommandFor(existing);
	const state = applySlotUpdate(
		next,
		existing,
		{
			...existing,
			status: isManualRetry ? 'retrying' : 'consuming',
			producerId: producerId ?? existing.producerId,
			consumerId: undefined,
			consumeGeneration,
			pendingSince: existing.pendingSince ?? now,
			lastFailureReason: undefined,
			lastFailureAt: undefined,
		},
		now,
	);

	return {
		state,
		commands: closeCommand ? [...cascadedCommands, closeCommand] : cascadedCommands,
	};
};

export const markRemoteConsumeSucceeded = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	producerId: string,
	consumerId: string,
	consumeGeneration?: number,
): TRemoteMediaReducerResult => {
	const existing = subscriptions.get(getPendingStreamKey(remoteId, kind));
	const base = existing ?? makeSubscription(remoteId, kind, now, producerId);

	if (consumeGeneration !== undefined && existing?.consumeGeneration !== consumeGeneration) {
		return emptyResult(subscriptions);
	}

	const closeCommand =
		existing?.consumerId !== undefined && existing.consumerId !== consumerId
			? closeConsumerCommandFor(existing)
			: undefined;
	const state = applySlotUpdate(
		subscriptions,
		existing,
		{
			...base,
			producerPresent: true,
			producerId,
			desired: true,
			status: 'consumed',
			consumerId,
			consumeGeneration: undefined,
			pendingSince: undefined,
			lastFailureReason: undefined,
			lastFailureAt: undefined,
		},
		now,
	);

	return {
		state,
		commands: closeCommand ? [closeCommand] : [],
	};
};

export const markRemoteConsumeFailed = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	reason?: string,
	consumeGeneration?: number,
): TRemoteMediaReducerResult => {
	const existing = subscriptions.get(getPendingStreamKey(remoteId, kind));
	const base = existing ?? makeSubscription(remoteId, kind, now);

	if (consumeGeneration !== undefined && existing?.consumeGeneration !== consumeGeneration) {
		return emptyResult(subscriptions);
	}

	return emptyResult(
		applySlotUpdate(
			subscriptions,
			existing,
			{
				...base,
				desired: true,
				status: 'failed',
				consumerId: undefined,
				consumeGeneration: undefined,
				pendingSince: base.pendingSince ?? now,
				lastFailureAt: now,
				lastFailureReason: reason,
			},
			now,
		),
	);
};

export const markRemoteProducerClosed = (
	subscriptions: TRemoteMediaSubscriptions,
	remoteId: number,
	kind: StreamKind,
	now: number,
	producerId?: string,
): TRemoteMediaReducerResult => {
	const key = getPendingStreamKey(remoteId, kind);
	const existing = subscriptions.get(key);

	if (!existing) {
		return emptyResult(subscriptions);
	}

	if (producerId !== undefined && existing.producerId !== undefined && existing.producerId !== producerId) {
		return emptyResult(subscriptions);
	}

	const closeCommand = closeConsumerCommandFor(existing);
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
			consumeGeneration: undefined,
			pendingSince: undefined,
		},
		now,
	);

	if (kind === StreamKind.SCREEN) {
		const audio = next.get(getPendingStreamKey(remoteId, StreamKind.SCREEN_AUDIO));

		// Only revoke screen-audio desire while it is actually held, so repeated
		// closes of an already-cleared screen stay no-ops.
		if (audio?.desired) {
			const audioCloseCommand = closeConsumerCommandFor(audio);
			next = applySlotUpdate(
				next,
				audio,
				{
					...audio,
					desired: false,
					status: 'available',
					consumeGeneration: undefined,
					pendingSince: audio.producerPresent ? now : undefined,
				},
				now,
			);
			if (audioCloseCommand) {
				return {
					state: next,
					commands: closeCommand ? [closeCommand, audioCloseCommand] : [audioCloseCommand],
				};
			}
		}
	}

	return {
		state: next,
		commands: closeCommand ? [closeCommand] : [],
	};
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
	context?: TRemoteMediaCommandContext,
): TRemoteMediaReducerResult => {
	const key = getPendingStreamKey(remoteId, kind);
	const existing = subscriptions.get(key);

	if (!existing || existing.status !== 'consumed') {
		return emptyResult(subscriptions);
	}

	if (consumerId !== undefined && existing.consumerId !== undefined && existing.consumerId !== consumerId) {
		return emptyResult(subscriptions);
	}

	const state = applySlotUpdate(
		subscriptions,
		existing,
		{
			...existing,
			status: existing.desired ? (existing.producerPresent ? 'wanted' : 'failed') : 'available',
			consumerId: undefined,
			consumeGeneration: undefined,
			pendingSince: existing.producerPresent ? now : undefined,
		},
		now,
	);

	return {
		state,
		commands: maybeConsumeCommand(state, key, context),
	};
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
): TRemoteMediaReducerResult => {
	const slots = producerSlotsFromSnapshot(producers, externalStreamTracks);
	const activeKeys = new Set(slots.map((slot) => getPendingStreamKey(slot.remoteId, slot.kind)));
	let next = subscriptions;
	const commands: TRemoteMediaCommand[] = [];
	const context = { externalStreamTracks };

	slots.forEach((slot) => {
		const result = markRemoteProducerPresent(next, slot.remoteId, slot.kind, now, slot.producerId, context);
		next = result.state;
		commands.push(...result.commands);
	});

	next.forEach((subscription) => {
		if (activeKeys.has(subscription.key)) {
			return;
		}

		const result = markRemoteProducerClosed(
			next,
			subscription.remoteId,
			subscription.kind,
			now,
			subscription.producerId,
		);
		next = result.state;
		commands.push(...result.commands);
	});

	return { state: next, commands };
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

const toVisibleRemoteMediaStatus = (subscription: TRemoteMediaSubscription): TVisibleRemoteMediaStatus => {
	switch (subscription.status) {
		case 'consumed':
			return 'live';
		case 'failed':
			return 'failed';
		case 'retrying':
			return 'retrying';
		case 'available':
		case 'wanted':
		case 'consuming':
			return 'pending';
	}
};

export const remoteMediaSubscriptionsToVisibleRemoteMedia = (
	subscriptions: TRemoteMediaSubscriptions,
): TVisibleRemoteMedia[] => {
	const visibleRemoteMedia: TVisibleRemoteMedia[] = [];

	subscriptions.forEach((subscription) => {
		if (!subscription.producerPresent && !subscription.desired) {
			return;
		}

		visibleRemoteMedia.push({
			key: subscription.key,
			remoteId: subscription.remoteId,
			kind: subscription.kind,
			status: toVisibleRemoteMediaStatus(subscription),
			subscriptionStatus: subscription.status,
			producerPresent: subscription.producerPresent,
			desired: subscription.desired,
			producerId: subscription.producerId,
		});
	});

	return visibleRemoteMedia;
};

export const remoteMediaSubscriptionsToStreamsToConsume = (
	subscriptions: TRemoteMediaSubscriptions,
	externalStreamTracks?: TExternalStreamTrackPresence,
): TStreamsToConsumeCommand[] => {
	const streamsToConsume: TStreamsToConsumeCommand[] = [];

	subscriptions.forEach((subscription) => {
		if (
			!subscription.producerPresent ||
			!subscription.desired ||
			subscription.status !== 'wanted' ||
			(isExternalStreamKind(subscription.kind) && !canConsumeExternalStream(subscription, externalStreamTracks)) ||
			!canConsumeScreenAudio(subscription, subscriptions)
		) {
			return;
		}

		streamsToConsume.push({
			type: 'consume',
			key: subscription.key,
			remoteId: subscription.remoteId,
			kind: subscription.kind,
			producerId: subscription.producerId,
			generation: nextConsumeGeneration(subscription),
		});
	});

	return streamsToConsume;
};

export const remoteMediaSubscriptionsToRepairScheduleCommand = (
	subscriptions: TRemoteMediaSubscriptions,
	pendingStreams: Map<string, TPendingStream>,
	currentExternalStreams: Record<number, unknown>,
): TScheduleRetryCommand | undefined => {
	const oldestRepairEligibleCreatedAt = getOldestRepairEligiblePendingCreatedAt(
		pendingStreams,
		(streamId, kind) =>
			currentExternalStreams[streamId] !== undefined &&
			subscriptions.get(getPendingStreamKey(streamId, kind))?.desired === true,
		(remoteId) => subscriptions.get(getPendingStreamKey(remoteId, StreamKind.SCREEN_AUDIO))?.desired === true,
	);

	if (oldestRepairEligibleCreatedAt === undefined) {
		return undefined;
	}

	return {
		type: 'scheduleRetry',
		key: 'remote-media-repair',
		retryAt: oldestRepairEligibleCreatedAt + PENDING_STREAM_REPAIR_AGE_MS,
		generation: oldestRepairEligibleCreatedAt,
	};
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
	// Subscriptions and the pending command queue share one atomic state so the
	// reducer runs inside a *pure* functional updater. Enqueuing commands used to
	// live as a nested setState side effect inside the subscriptions updater,
	// which StrictMode's intentional double-invoke turned into duplicate
	// consume/close operations.
	const [remoteMediaState, setRemoteMediaState] = useState<{
		subscriptions: TRemoteMediaSubscriptions;
		commands: TRemoteMediaCommand[];
	}>(() => ({ subscriptions: new Map(), commands: [] }));
	const { subscriptions: remoteMediaSubscriptions, commands: remoteMediaCommands } = remoteMediaState;
	const update = useCallback((nextFor: (prev: TRemoteMediaSubscriptions, now: number) => TRemoteMediaReducerResult) => {
		setRemoteMediaState((prev) => {
			const result = nextFor(prev.subscriptions, Date.now());
			const nextSubscriptions = hasSubscriptionChanged(prev.subscriptions, result.state)
				? result.state
				: prev.subscriptions;

			if (nextSubscriptions === prev.subscriptions && result.commands.length === 0) {
				return prev;
			}

			return {
				subscriptions: nextSubscriptions,
				commands: result.commands.length > 0 ? [...prev.commands, ...result.commands] : prev.commands,
			};
		});
	}, []);
	const clearRemoteMediaCommands = useCallback((commandsToClear: TRemoteMediaCommand[]) => {
		if (commandsToClear.length === 0) {
			return;
		}

		setRemoteMediaState((prev) => ({ ...prev, commands: prev.commands.slice(commandsToClear.length) }));
	}, []);
	const pendingStreams = useMemo(
		() => remoteMediaSubscriptionsToPendingStreams(remoteMediaSubscriptions),
		[remoteMediaSubscriptions],
	);
	const visibleRemoteMedia = useMemo(
		() => remoteMediaSubscriptionsToVisibleRemoteMedia(remoteMediaSubscriptions),
		[remoteMediaSubscriptions],
	);
	const addPendingStream = useCallback(
		(remoteId: number, kind: StreamKind, producerId?: string, externalStreamTracks?: TExternalStreamTrackPresence) => {
			update((prev, now) => markRemoteProducerPresent(prev, remoteId, kind, now, producerId, { externalStreamTracks }));
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
			update((prev) => emptyResult(clearRemoteMediaForUser(prev, remoteId)));
		},
		[update],
	);
	const clearAllPendingStreams = useCallback(() => {
		setRemoteMediaState((prev) =>
			prev.subscriptions.size === 0 && prev.commands.length === 0 ? prev : { subscriptions: new Map(), commands: [] },
		);
	}, []);
	const reconcilePendingStreams = useCallback(
		(producers: TRemoteProducerIds, externalStreamTracks?: TExternalStreamTrackPresence) => {
			update((prev, now) => reconcileRemoteMediaWithProducerSnapshot(prev, producers, externalStreamTracks, now));
		},
		[update],
	);
	const refreshPendingStreamAges = useCallback(() => {
		update((prev, now) => emptyResult(refreshRemoteMediaPendingAges(prev, now)));
	}, [update]);
	const markWatchRequested = useCallback(
		(remoteId: number, kind: StreamKind, externalStreamTracks?: TExternalStreamTrackPresence) => {
			update((prev, now) => markRemoteWatchRequested(prev, remoteId, kind, now, { externalStreamTracks }));
		},
		[update],
	);
	const markWatchStopped = useCallback(
		(remoteId: number, kind: StreamKind) => {
			update((prev, now) => markRemoteWatchStopped(prev, remoteId, kind, now));
		},
		[update],
	);
	const markRetryRequested = useCallback(
		(remoteId: number, kind: StreamKind, externalStreamTracks?: TExternalStreamTrackPresence) => {
			update((prev, now) => markRemoteRetryRequested(prev, remoteId, kind, now, { externalStreamTracks }));
		},
		[update],
	);
	const markConsumeStarted = useCallback(
		(remoteId: number, kind: StreamKind, producerId?: string, consumeGeneration?: number, isManualRetry = false) => {
			update((prev, now) =>
				markRemoteConsumeStarted(prev, remoteId, kind, now, producerId, consumeGeneration, isManualRetry),
			);
		},
		[update],
	);
	const markConsumeSucceeded = useCallback(
		(remoteId: number, kind: StreamKind, producerId: string, consumerId: string, consumeGeneration?: number) => {
			update((prev, now) =>
				markRemoteConsumeSucceeded(prev, remoteId, kind, now, producerId, consumerId, consumeGeneration),
			);
		},
		[update],
	);
	const markConsumeFailed = useCallback(
		(remoteId: number, kind: StreamKind, reason?: string, consumeGeneration?: number) => {
			update((prev, now) => markRemoteConsumeFailed(prev, remoteId, kind, now, reason, consumeGeneration));
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
			update((prev) => emptyResult(clearRemoteMediaForExternalStream(prev, streamId)));
		},
		[update],
	);

	return {
		remoteMediaSubscriptions,
		remoteMediaCommands,
		pendingStreams,
		visibleRemoteMedia,
		clearRemoteMediaCommands,
		addPendingStream,
		removePendingStream,
		clearPendingStreamsForUser,
		clearAllPendingStreams,
		reconcilePendingStreams,
		refreshPendingStreamAges,
		markWatchRequested,
		markWatchStopped,
		markRetryRequested,
		markConsumeStarted,
		markConsumeSucceeded,
		markConsumeFailed,
		markConsumerClosed,
		clearExternalStream,
	};
};
