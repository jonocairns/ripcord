import type { IServerState } from '../slice';

export const ownConfirmedVoiceStateSelector = (state: IServerState) => {
	const { currentVoiceChannelId, ownUserId } = state;

	if (currentVoiceChannelId === undefined || ownUserId === undefined) {
		return undefined;
	}

	return state.voiceMap[currentVoiceChannelId]?.users[ownUserId];
};

export const ownVoiceStateSelector = (state: IServerState) =>
	ownConfirmedVoiceStateSelector(state) ?? state.ownVoiceDefaults;

export const pinnedCardSelector = (state: IServerState) => state.pinnedCard;

export const voiceChannelStateSelector = (state: IServerState, channelId: number) => state.voiceMap[channelId];

export const voiceChannelExternalStreamsSelector = (state: IServerState, channelId: number) =>
	state.externalStreamsMap[channelId];
