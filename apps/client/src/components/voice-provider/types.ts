import type { StreamKind, TRemoteProducerIds, TTransportParams, TVoiceUserState } from '@sharkord/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import type { TVoiceSessionConnectionStatus } from '@/features/server/voice/voice-session-machine';
import type { useRemoteMediaSubscriptions } from './remote-media/remote-media-subscriptions';
import type { useRemoteStreams } from './remote-media/use-remote-streams';
import type { useLocalStreams } from './use-local-streams';
import type { useVoiceControls } from './use-voice-controls';

type AudioVideoRefs = {
	videoRef: React.RefObject<HTMLVideoElement | null>;
	audioRef: React.RefObject<HTMLAudioElement | null>;
	screenShareRef: React.RefObject<HTMLVideoElement | null>;
	screenShareAudioRef: React.RefObject<HTMLAudioElement | null>;
	externalAudioRef: React.RefObject<HTMLAudioElement | null>;
	externalVideoRef: React.RefObject<HTMLVideoElement | null>;
};

type TConnectionStatus = TVoiceSessionConnectionStatus;

type TRepublishedLocalMediaState = Partial<Pick<TVoiceUserState, 'webcamEnabled' | 'sharingScreen'>>;

type TInitResult = {
	republishedLocalMediaState: TRepublishedLocalMediaState;
};

type TVoiceProvider = {
	connectionStatus: TConnectionStatus;
	ownVoiceState: TVoiceUserState;
	getOrCreateRefs: (remoteId: number) => AudioVideoRefs;
	acceptStream: (remoteId: number, kind: StreamKind) => void;
	retryRemoteMedia: (remoteId: number, kind: StreamKind) => void;
	stopWatchingStream: (remoteId: number, kind: StreamKind) => void;
	init: (
		routerRtpCapabilities: RtpCapabilities,
		channelId: number,
		opts?: {
			producerTransportParams?: TTransportParams;
			consumerTransportParams?: TTransportParams;
			existingProducers?: TRemoteProducerIds;
			preserveLocalMedia?: boolean;
		},
	) => Promise<TInitResult>;
} & Pick<
	ReturnType<typeof useLocalStreams>,
	'localAudioStream' | 'localVideoStream' | 'localScreenShareStream' | 'localScreenShareAudioStream'
> &
	Pick<ReturnType<typeof useRemoteStreams>, 'remoteUserStreams' | 'externalStreams'> &
	Pick<
		ReturnType<typeof useRemoteMediaSubscriptions>,
		'pendingStreams' | 'remoteMediaSubscriptions' | 'visibleRemoteMedia'
	> &
	Omit<ReturnType<typeof useVoiceControls>, 'commitTerminalMicMuted'>;

export type { AudioVideoRefs, TConnectionStatus, TRepublishedLocalMediaState, TVoiceProvider };
