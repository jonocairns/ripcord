import { VoiceProviderContext } from '@/components/voice-provider';
import { useContext, useMemo } from 'react';
import { useServerStore } from '../slice';
import {
  ownVoiceStateSelector,
  pinnedCardSelector,
  voiceChannelExternalStreamsSelector,
  voiceChannelStateSelector
} from './selectors';

export const useVoiceChannelState = (channelId: number) =>
  useServerStore((state) => voiceChannelStateSelector(state, channelId));

export const useVoiceChannelExternalStreams = (channelId: number) =>
  useServerStore((state) =>
    voiceChannelExternalStreamsSelector(state, channelId)
  );

export const useVoiceChannelExternalStreamsList = (channelId: number) => {
  const externalStreams = useVoiceChannelExternalStreams(channelId);

  return useMemo(
    () =>
      Object.entries(externalStreams || {}).map(([streamId, stream]) => ({
        streamId: Number(streamId),
        ...stream
      })),
    [externalStreams]
  );
};

export const useVoiceChannelAudioExternalStreams = (channelId: number) => {
  const streams = useVoiceChannelExternalStreamsList(channelId);

  return useMemo(
    () => streams.filter((stream) => stream.tracks?.audio === true),
    [streams]
  );
};

export const useVoiceChannelVideoExternalStreams = (channelId: number) => {
  const streams = useVoiceChannelExternalStreamsList(channelId);

  return useMemo(
    () => streams.filter((stream) => stream.tracks?.video === true),
    [streams]
  );
};

export const useVoice = () => {
  const context = useContext(VoiceProviderContext);

  if (!context) {
    throw new Error(
      'useVoice must be used within a MediasoupProvider component'
    );
  }

  return context;
};

export const useOwnVoiceState = () => useServerStore(ownVoiceStateSelector);

export const usePinnedCard = () => useServerStore(pinnedCardSelector);
