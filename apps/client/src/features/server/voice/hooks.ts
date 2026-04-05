import { useContext, useMemo } from 'react';
import { VoiceProviderContext } from '@/components/voice-provider';
import { useServerStore } from '../slice';
import {
	ownConfirmedVoiceStateSelector,
	ownVoiceStateSelector,
	pinnedCardSelector,
	voiceChannelExternalStreamsSelector,
} from './selectors';

export const useVoiceChannelExternalStreams = (channelId: number) =>
	useServerStore((state) => voiceChannelExternalStreamsSelector(state, channelId));

export const useVoiceChannelExternalStreamsList = (channelId: number) => {
	const externalStreams = useVoiceChannelExternalStreams(channelId);

	return useMemo(
		() =>
			Object.entries(externalStreams || {}).map(([streamId, stream]) => ({
				streamId: Number(streamId),
				...stream,
			})),
		[externalStreams],
	);
};

export const useVoice = () => {
	const context = useContext(VoiceProviderContext);

	if (!context) {
		throw new Error('useVoice must be used within a MediasoupProvider component');
	}

	return context;
};

export const useConfirmedOwnVoiceState = () => useServerStore(ownConfirmedVoiceStateSelector);

export const useOwnVoiceState = () => useServerStore(ownVoiceStateSelector);

export const usePinnedCard = () => useServerStore(pinnedCardSelector);
