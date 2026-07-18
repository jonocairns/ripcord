import { StreamKind } from '@sharkord/shared';
import type { TRemoteMediaSubscriptions } from './remote-media-subscriptions';
import { PENDING_STREAM_REPAIR_AGE_MS, type TPendingStream } from './use-pending-streams';

const REMOTE_MEDIA_REPAIR_BACKOFF_MULTIPLIERS = [1, 2, 4] as const;

const getRemoteMediaRepairIdentity = (input: {
	channelId: number;
	subscriptions: TRemoteMediaSubscriptions;
	pendingStreams: Map<string, TPendingStream>;
	currentExternalStreams: Record<number, unknown>;
}): string | undefined => {
	const identities: string[] = [];

	input.pendingStreams.forEach((stream, key) => {
		const subscription = input.subscriptions.get(key);
		const repairEligible =
			stream.kind === StreamKind.AUDIO ||
			(stream.kind === StreamKind.SCREEN_AUDIO && subscription?.desired === true) ||
			((stream.kind === StreamKind.EXTERNAL_AUDIO || stream.kind === StreamKind.EXTERNAL_VIDEO) &&
				input.currentExternalStreams[stream.remoteId] !== undefined &&
				subscription?.desired === true);

		if (!repairEligible) {
			return;
		}

		identities.push(`${stream.remoteId}:${stream.kind}:${stream.producerId ?? subscription?.producerId ?? 'unknown'}`);
	});

	if (identities.length === 0) {
		return undefined;
	}

	identities.sort();
	return `${input.channelId}|${identities.join('|')}`;
};

const getRemoteMediaRepairDelayMs = (completedAttempts: number): number | undefined => {
	const multiplier = REMOTE_MEDIA_REPAIR_BACKOFF_MULTIPLIERS[completedAttempts];
	return multiplier === undefined ? undefined : PENDING_STREAM_REPAIR_AGE_MS * multiplier;
};

export { getRemoteMediaRepairDelayMs, getRemoteMediaRepairIdentity };
