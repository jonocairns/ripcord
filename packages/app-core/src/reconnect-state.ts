let pendingVoiceReconnectChannelId: number | undefined;
let pendingVoiceReconnectRetryCount = 0;

const setPendingVoiceReconnectChannelId = (channelId: number | undefined): void => {
	pendingVoiceReconnectChannelId = channelId;
	pendingVoiceReconnectRetryCount = 0;
};

const getPendingVoiceReconnectChannelId = (): number | undefined => pendingVoiceReconnectChannelId;

const getPendingVoiceReconnectRetryCount = (): number => pendingVoiceReconnectRetryCount;

const incrementPendingVoiceReconnectRetryCount = (): number => {
	pendingVoiceReconnectRetryCount += 1;
	return pendingVoiceReconnectRetryCount;
};

const clearPendingVoiceReconnectChannelId = (): void => {
	pendingVoiceReconnectChannelId = undefined;
	pendingVoiceReconnectRetryCount = 0;
};

export {
	clearPendingVoiceReconnectChannelId,
	getPendingVoiceReconnectChannelId,
	getPendingVoiceReconnectRetryCount,
	incrementPendingVoiceReconnectRetryCount,
	setPendingVoiceReconnectChannelId,
};
