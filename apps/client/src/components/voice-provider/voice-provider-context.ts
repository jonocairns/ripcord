import { createContext } from 'react';
import type { TransportStatsStore } from './hooks/use-transport-stats';
import { createEmptyAudioVideoRefs } from './media-element-refs';
import type { TVoiceProvider } from './types';
import type { VoiceActivityStore } from './voice-activity';

const VoiceProviderContext = createContext<TVoiceProvider>({
	connectionStatus: 'disconnected',
	getOrCreateRefs: () => createEmptyAudioVideoRefs(),
	acceptStream: () => undefined,
	retryRemoteMedia: () => undefined,
	stopWatchingStream: () => undefined,
	init: () => Promise.resolve({ republishedLocalMediaState: {} }),
	isStartingScreenShare: false,
	setMicMuted: () => Promise.resolve(),
	toggleMic: () => Promise.resolve(),
	toggleSound: () => Promise.resolve(),
	toggleWebcam: () => Promise.resolve(),
	toggleScreenShare: () => Promise.resolve(),
	ownVoiceState: {
		micMuted: false,
		soundMuted: false,
		webcamEnabled: false,
		sharingScreen: false,
	},
	localAudioStream: undefined,
	localVideoStream: undefined,
	localScreenShareStream: undefined,
	localScreenShareAudioStream: undefined,

	remoteUserStreams: {},
	externalStreams: {},
	pendingStreams: new Map(),
	remoteMediaSubscriptions: new Map(),
	visibleRemoteMedia: [],
});

const VoiceActivityContext = createContext<VoiceActivityStore | null>(null);

// Transport stats update at 1 Hz for the whole voice session. They live in a
// dedicated subscribe/snapshot store (separate from VoiceProviderContext) so
// only the components that display them re-render on each sample.
const TransportStatsContext = createContext<TransportStatsStore | null>(null);

export { TransportStatsContext, VoiceActivityContext, VoiceProviderContext };
