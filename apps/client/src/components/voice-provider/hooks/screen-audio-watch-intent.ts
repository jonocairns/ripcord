import { StreamKind } from '@sharkord/shared';
import type { TPendingStream } from './use-pending-streams';

// Accepting the screen itself must set audio intent: screen audio can appear
// after the viewer is already watching video, and the stage hides the pending
// card once video is consumed, so a later opt-in has no affordance.
const tracksScreenAudioWatchIntent = (kind: StreamKind): boolean => {
	return kind === StreamKind.SCREEN || kind === StreamKind.SCREEN_AUDIO;
};

// Pending SCREEN_AUDIO entries the provider should auto-consume because the
// viewer still intends to hear them.
const selectWatchedPendingScreenAudioIds = (
	pendingStreams: Map<string, TPendingStream>,
	isScreenAudioWatched: (remoteId: number) => boolean,
): number[] => {
	const remoteIds: number[] = [];

	pendingStreams.forEach((stream) => {
		if (stream.kind !== StreamKind.SCREEN_AUDIO || !isScreenAudioWatched(stream.remoteId)) {
			return;
		}

		remoteIds.push(stream.remoteId);
	});

	return remoteIds;
};

export { selectWatchedPendingScreenAudioIds, tracksScreenAudioWatchIntent };
