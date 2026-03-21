import type { IServerState } from '../slice';

const DEFAULT_OBJECT = {};

export const voiceMapSelector = (state: IServerState) => state.voiceMap;

export const ownVoiceStateSelector = (state: IServerState) => state.ownVoiceState;

export const pinnedCardSelector = (state: IServerState) => state.pinnedCard;

export const voiceChannelStateSelector = (state: IServerState, channelId: number) => state.voiceMap[channelId];

export const voiceChannelExternalStreamsSelector = (state: IServerState, channelId: number) =>
	state.externalStreamsMap[channelId];

export const voiceChannelExternalStreamsListSelector = (state: IServerState, channelId: number) =>
	Object.entries(voiceChannelExternalStreamsSelector(state, channelId) || DEFAULT_OBJECT).map(([streamId, stream]) => ({
		streamId: Number(streamId),
		...stream,
	}));

export const voiceChannelAudioExternalStreamsSelector = (state: IServerState, channelId: number) =>
	voiceChannelExternalStreamsListSelector(state, channelId).filter((stream) => stream.tracks?.audio === true);

export const voiceChannelVideoExternalStreamsSelector = (state: IServerState, channelId: number) =>
	voiceChannelExternalStreamsListSelector(state, channelId).filter((stream) => stream.tracks?.video === true);
