import type { IRootState } from '@/features/store';
import { StreamKind } from '@sharkord/shared';
import { createCachedSelector } from 're-reselect';

const DEFAULT_OBJECT = {};

export const voiceMapSelector = (state: IRootState) => state.server.voiceMap;

export const ownVoiceStateSelector = (state: IRootState) => {
  return state.server.ownVoiceState;
};

export const pinnedCardSelector = (state: IRootState) =>
  state.server.pinnedCard;

export const voiceChannelStateSelector = (
  state: IRootState,
  channelId: number
) => state.server.voiceMap[channelId];

export const voiceChannelExternalStreamsSelector = (
  state: IRootState,
  channelId: number
) => state.server.externalStreamsMap[channelId];

export const voiceChannelExternalStreamsListSelector = createCachedSelector(
  voiceChannelExternalStreamsSelector,
  (externalStreamsMap) => {
    return Object.entries(externalStreamsMap || DEFAULT_OBJECT).map(
      ([streamId, stream]) => ({
        streamId: Number(streamId),
        ...stream
      })
    );
  }
)((_state: IRootState, channelId: number) => channelId);

export const voiceChannelAudioExternalStreamsSelector = createCachedSelector(
  voiceChannelExternalStreamsListSelector,
  (externalStreamsMap) =>
    externalStreamsMap.filter(
      (stream) => stream.type === StreamKind.EXTERNAL_AUDIO
    )
)((_state: IRootState, channelId: number) => channelId);

export const voiceChannelVideoExternalStreamsSelector = createCachedSelector(
  voiceChannelExternalStreamsListSelector,
  (externalStreamsMap) =>
    externalStreamsMap.filter(
      (stream) => stream.type === StreamKind.EXTERNAL_VIDEO
    )
)((_state: IRootState, channelId: number) => channelId);
