let pendingVoiceReconnectChannelId: number | undefined;

const setPendingVoiceReconnectChannelId = (
  channelId: number | undefined
): void => {
  pendingVoiceReconnectChannelId = channelId;
};

const getPendingVoiceReconnectChannelId = (): number | undefined =>
  pendingVoiceReconnectChannelId;

const clearPendingVoiceReconnectChannelId = (): void => {
  pendingVoiceReconnectChannelId = undefined;
};

export {
  clearPendingVoiceReconnectChannelId,
  getPendingVoiceReconnectChannelId,
  setPendingVoiceReconnectChannelId
};
