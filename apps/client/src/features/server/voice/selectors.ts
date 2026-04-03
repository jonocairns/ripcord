import type { IServerState } from '../slice';

export const ownVoiceStateSelector = (state: IServerState) => state.ownVoiceState;

export const pinnedCardSelector = (state: IServerState) => state.pinnedCard;

export const voiceChannelStateSelector = (state: IServerState, channelId: number) => state.voiceMap[channelId];

export const voiceChannelExternalStreamsSelector = (state: IServerState, channelId: number) =>
	state.externalStreamsMap[channelId];

