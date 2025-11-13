import type { IRootState } from '@/features/store';

export const voiceChannelStateSelector = (
  state: IRootState,
  channelId: number
) => {
  return state.server.voice[channelId];
};

export const ownVoiceStateSelector = (state: IRootState) => {
  return state.server.ownVoiceState;
};
