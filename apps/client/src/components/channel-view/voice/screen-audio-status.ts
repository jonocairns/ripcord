import type { TVisibleRemoteMedia } from '@/components/voice-provider/remote-media/remote-media-subscriptions';

type TScreenAudioStatus = 'live' | 'connecting' | 'failed' | 'stopped' | 'none';

type TScreenAudioSlot = Pick<TVisibleRemoteMedia, 'desired' | 'status' | 'producerPresent'>;

// A playable audio stream wins over slot bookkeeping, which can lag behind it.
// Without one, the slot says whether audio is on its way, failed, was stopped
// by the viewer, or was never shared.
const getScreenAudioStatus = (hasAudioStream: boolean, slot: TScreenAudioSlot | undefined): TScreenAudioStatus => {
	if (hasAudioStream) return 'live';
	if (slot?.desired) return slot.status === 'failed' ? 'failed' : 'connecting';
	if (slot?.producerPresent) return 'stopped';
	return 'none';
};

const SCREEN_AUDIO_STATUS_LABELS: Record<Exclude<TScreenAudioStatus, 'live'>, string> = {
	connecting: 'Screen audio connecting',
	failed: 'Screen audio unavailable',
	stopped: 'Screen audio stopped',
	none: 'No audio in this share',
};

export { getScreenAudioStatus, SCREEN_AUDIO_STATUS_LABELS, type TScreenAudioStatus };
