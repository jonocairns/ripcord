import type { StreamKind, TRemoteProducerIds } from '@sharkord/shared';
import { useCallback, useState, useSyncExternalStore } from 'react';
import type { TWatchedRemoteStreamsSnapshot } from '@/features/server/voice/voice-session-machine';
import { logVoice } from '@/helpers/browser-logger';
import { recordStreamEvent } from '@/helpers/stream-observability';
import { createRemoteMediaLedgerStore } from './remote-media-ledger-store';
import {
	clearRemoteMediaForExternalStream,
	clearRemoteMediaForUser,
	markRemoteConsumeFailed,
	markRemoteConsumerClosed,
	markRemoteConsumeStarted,
	markRemoteConsumeSucceeded,
	markRemoteMediaRepairAttemptStarted,
	markRemoteProducerClosed,
	markRemoteProducerPresent,
	markRemoteRetryRequested,
	markRemoteWatchRequested,
	markRemoteWatchStopped,
	reconcileRemoteMediaWithProducerSnapshot,
	rehydrateRemoteMediaWatchIntentOnly,
	type TRemoteMediaRepairScheduleCommand,
} from './remote-media-subscriptions';
import type { TExternalStreamTrackPresence } from './use-pending-streams';
import { getWatchIntentEvents } from './watch-intent-observability';

export const useRemoteMediaSubscriptions = () => {
	const [ledgerStore] = useState(() =>
		createRemoteMediaLedgerStore({
			now: Date.now,
			onTransition: (previous, next) => {
				for (const event of getWatchIntentEvents(previous, next)) recordStreamEvent(event);
			},
			onCommandError: (error, command) => logVoice('Remote media command failed', { error, command }),
		}),
	);
	const remoteMediaSubscriptions = useSyncExternalStore(ledgerStore.subscribe, ledgerStore.getSnapshot);
	const pendingStreams = useSyncExternalStore(ledgerStore.subscribe, ledgerStore.getPendingStreams);
	const visibleRemoteMedia = useSyncExternalStore(ledgerStore.subscribe, ledgerStore.getVisibleRemoteMedia);
	const update = ledgerStore.dispatch;

	const addPendingStream = useCallback(
		(remoteId: number, kind: StreamKind, producerId?: string, externalStreamTracks?: TExternalStreamTrackPresence) => {
			update((prev, now) => markRemoteProducerPresent(prev, remoteId, kind, now, producerId, { externalStreamTracks }));
		},
		[update],
	);
	const removePendingStream = useCallback(
		(remoteId: number, kind: StreamKind, producerId?: string, options?: { preserveDesired?: boolean }) => {
			update((prev, now) => markRemoteProducerClosed(prev, remoteId, kind, now, producerId, options));
		},
		[update],
	);
	const clearPendingStreamsForUser = useCallback(
		(remoteId: number) => {
			update((prev) => ({ state: clearRemoteMediaForUser(prev, remoteId), commands: [] }));
		},
		[update],
	);
	const clearAllPendingStreams = useCallback(
		(opts?: { preserveIntent?: boolean }) => {
			ledgerStore.clear(opts);
		},
		[ledgerStore],
	);

	const reconcilePendingStreams = useCallback(
		(producers: TRemoteProducerIds, externalStreamTracks?: TExternalStreamTrackPresence) => {
			update((prev, now) => reconcileRemoteMediaWithProducerSnapshot(prev, producers, externalStreamTracks, now));
		},
		[update],
	);
	const markRepairAttemptStarted = useCallback(
		(
			command: TRemoteMediaRepairScheduleCommand,
			currentVoiceChannelId: number | undefined,
			currentExternalStreams: Record<number, unknown>,
		) => {
			update((prev, now) => ({
				state: markRemoteMediaRepairAttemptStarted(prev, command, now, currentVoiceChannelId, currentExternalStreams),
				commands: [],
			}));
		},
		[update],
	);
	const markWatchRequested = useCallback(
		(remoteId: number, kind: StreamKind, externalStreamTracks?: TExternalStreamTrackPresence) => {
			recordStreamEvent({ event: 'watch_requested', remoteId, kind, mode: 'manual' });
			update((prev, now) => markRemoteWatchRequested(prev, remoteId, kind, now, { externalStreamTracks }));
		},
		[update],
	);
	const markWatchStopped = useCallback(
		(remoteId: number, kind: StreamKind) => {
			recordStreamEvent({ event: 'watch_stopped', remoteId, kind, mode: 'manual' });
			update((prev, now) => markRemoteWatchStopped(prev, remoteId, kind, now));
		},
		[update],
	);
	const markRetryRequested = useCallback(
		(remoteId: number, kind: StreamKind, externalStreamTracks?: TExternalStreamTrackPresence) => {
			recordStreamEvent({ event: 'watch_retry_requested', remoteId, kind, mode: 'manual' });
			update((prev, now) => markRemoteRetryRequested(prev, remoteId, kind, now, { externalStreamTracks }));
		},
		[update],
	);
	const rehydrateWatchIntentOnly = useCallback(
		(snapshot: TWatchedRemoteStreamsSnapshot) => {
			update((prev, now) => rehydrateRemoteMediaWatchIntentOnly(prev, snapshot, now));
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
			update((prev) => ({ state: clearRemoteMediaForExternalStream(prev, streamId), commands: [] }));
		},
		[update],
	);

	return {
		remoteMediaSubscriptions,
		ledgerStore,
		pendingStreams,
		visibleRemoteMedia,
		addPendingStream,
		removePendingStream,
		clearPendingStreamsForUser,
		clearAllPendingStreams,
		reconcilePendingStreams,
		markRepairAttemptStarted,
		markWatchRequested,
		markWatchStopped,
		markRetryRequested,
		rehydrateWatchIntentOnly,
		markConsumeStarted,
		markConsumeSucceeded,
		markConsumeFailed,
		markConsumerClosed,
		clearExternalStream,
	};
};
