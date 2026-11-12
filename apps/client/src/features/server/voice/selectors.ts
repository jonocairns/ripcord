import type { TVoiceUserState } from '@sharkord/shared';
import type { IServerState } from '../slice';
import { resolveOwnVoiceState } from './own-voice-state';

const resolve = (state: IServerState) =>
	resolveOwnVoiceState({
		intent: state.ownVoiceIntent,
		pushHold: state.ownPushHold,
		micTestActive: state.ownMicTestActive,
	});
let cachedVoice: TVoiceUserState | undefined;
export const ownVoiceStateSelector = (state: IServerState): TVoiceUserState => {
	const audio = resolve(state);
	const row =
		state.currentVoiceChannelId !== undefined && state.ownUserId !== undefined
			? state.voiceMap[state.currentVoiceChannelId]?.users[state.ownUserId]
			: undefined;
	const next = {
		micMuted: audio.micMuted,
		soundMuted: audio.soundMuted,
		webcamEnabled: row?.webcamEnabled ?? false,
		sharingScreen: row?.sharingScreen ?? false,
	};
	if (
		cachedVoice &&
		cachedVoice.micMuted === next.micMuted &&
		cachedVoice.soundMuted === next.soundMuted &&
		cachedVoice.webcamEnabled === next.webcamEnabled &&
		cachedVoice.sharingScreen === next.sharingScreen
	)
		return cachedVoice;
	cachedVoice = next;
	return next;
};
export const ownMicWantedSelector = (state: IServerState) => resolve(state).micWanted;
export const ownTransmittingSelector = (state: IServerState) => resolve(state).transmitting;
let cachedPayload: { micMuted: boolean; soundMuted: boolean } | undefined;
export const ownVoiceSessionPayloadSelector = (state: IServerState) => {
	const audio = resolve(state);
	const next = { micMuted: audio.restingMicMuted, soundMuted: audio.soundMuted };
	if (cachedPayload && cachedPayload.micMuted === next.micMuted && cachedPayload.soundMuted === next.soundMuted)
		return cachedPayload;
	cachedPayload = next;
	return next;
};

export const pinnedCardSelector = (state: IServerState) => state.pinnedCard;

export const voiceChannelStateSelector = (state: IServerState, channelId: number) => state.voiceMap[channelId];

export const voiceChannelExternalStreamsSelector = (state: IServerState, channelId: number) =>
	state.externalStreamsMap[channelId];
