import { shouldRestoreVoiceAfterDisconnect } from './disconnect-utils';

type TResolvePendingVoiceReconnectChannelIdOnDisconnectInput = {
	wasConnected: boolean;
	disconnectCode: number;
	currentVoiceChannelId: number | undefined;
	pendingVoiceChannelId: number | undefined;
};

type TResolveTransportFailureVoiceReconnectStateInput = {
	isConnected: boolean;
	currentVoiceChannelId: number | undefined;
};

type TResolveTransportFailureVoiceReconnectStateResult = {
	pendingVoiceReconnectChannelId: number | undefined;
	shouldClearCurrentVoiceChannelId: boolean;
};

const resolvePendingVoiceReconnectChannelIdOnDisconnect = ({
	wasConnected,
	disconnectCode,
	currentVoiceChannelId,
	pendingVoiceChannelId,
}: TResolvePendingVoiceReconnectChannelIdOnDisconnectInput): number | undefined => {
	if (!wasConnected || !shouldRestoreVoiceAfterDisconnect(disconnectCode)) {
		return undefined;
	}

	return currentVoiceChannelId ?? pendingVoiceChannelId;
};

const resolveTransportFailureVoiceReconnectState = ({
	isConnected,
	currentVoiceChannelId,
}: TResolveTransportFailureVoiceReconnectStateInput): TResolveTransportFailureVoiceReconnectStateResult => {
	if (!isConnected || currentVoiceChannelId === undefined) {
		return {
			pendingVoiceReconnectChannelId: undefined,
			shouldClearCurrentVoiceChannelId: false,
		};
	}

	return {
		pendingVoiceReconnectChannelId: currentVoiceChannelId,
		shouldClearCurrentVoiceChannelId: true,
	};
};

export type {
	TResolvePendingVoiceReconnectChannelIdOnDisconnectInput,
	TResolveTransportFailureVoiceReconnectStateInput,
	TResolveTransportFailureVoiceReconnectStateResult,
};
export { resolvePendingVoiceReconnectChannelIdOnDisconnect, resolveTransportFailureVoiceReconnectState };
