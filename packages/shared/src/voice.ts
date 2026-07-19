import type { IceCandidate, IceParameters } from 'mediasoup/types';
import type { TExternalStreamTracks } from './types';

export const VOICE_MEDIA_LIVENESS_CHECK_INTERVAL_MS = 5_000;
export const VOICE_MEDIA_LIVENESS_TIMEOUT_MS = 45_000;
export const VOICE_MEDIA_LIVENESS_JITTER_MS = 15_000;

// A rebuilt consumer transport may wait one monitor interval for its first
// baseline, then the full timeout + jitter, then one final interval before the
// server observes the deadline. Keep client recovery probation beyond that
// complete detector horizon so a transport that never moves media cannot earn
// a fresh recovery budget before the watchdog is capable of reporting it.
export const VOICE_MEDIA_LIVENESS_MAX_DETECTION_MS =
	VOICE_MEDIA_LIVENESS_TIMEOUT_MS + VOICE_MEDIA_LIVENESS_JITTER_MS + VOICE_MEDIA_LIVENESS_CHECK_INTERVAL_MS * 2;
const VOICE_TRANSPORT_RECOVERY_PROBATION_MARGIN_MS = 20_000;
export const VOICE_TRANSPORT_RECOVERY_PROBATION_MS =
	VOICE_MEDIA_LIVENESS_MAX_DETECTION_MS + VOICE_TRANSPORT_RECOVERY_PROBATION_MARGIN_MS;

export type TVoiceTransportFailureSource = 'consumer-dtls' | 'producer-dtls' | 'media-liveness';

export type TVoiceTransportFailureEvent = {
	userId: number;
	// Optional for compatibility with already-shipped servers and clients.
	source?: TVoiceTransportFailureSource;
	transportId?: string;
};

export type TVoiceUserState = {
	micMuted: boolean;
	soundMuted: boolean;
	webcamEnabled: boolean;
	sharingScreen: boolean;
};

export type TVoiceUser = {
	userId: number;
	state: TVoiceUserState;
};

export type TExternalStream = {
	title: string;
	key: string;
	pluginId: string;
	avatarUrl?: string;
	tracks: TExternalStreamTracks;
};

export type TChannelState = {
	users: TVoiceUser[];
	externalStreams: { [streamId: number]: TExternalStream };
};

export type TTransportParams = {
	id: string;
	iceParameters: IceParameters;
	iceCandidates: IceCandidate[];
	dtlsParameters: any;
};

export type TVoiceMap = {
	[channelId: number]: {
		users: {
			[userId: number]: TVoiceUserState;
		};
	};
};

export type TExternalStreamsMap = {
	[channelId: number]: {
		[streamId: number]: TExternalStream;
	};
};
