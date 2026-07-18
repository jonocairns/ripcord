import { PENDING_STREAM_REPAIR_AGE_MS } from './use-pending-streams';

const REMOTE_MEDIA_REPAIR_BACKOFF_MULTIPLIERS = [1, 2, 4] as const;

const getRemoteMediaRepairDelayMs = (completedAttempts: number): number | undefined => {
	const multiplier = REMOTE_MEDIA_REPAIR_BACKOFF_MULTIPLIERS[completedAttempts];
	return multiplier === undefined ? undefined : PENDING_STREAM_REPAIR_AGE_MS * multiplier;
};

export { getRemoteMediaRepairDelayMs };
