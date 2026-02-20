let pendingVoiceReconnectChannelId: number | undefined;

const setPendingVoiceReconnectChannelId = (
  channelId: number | undefined
): void => {
  pendingVoiceReconnectChannelId = channelId;
};

const consumePendingVoiceReconnectChannelId = (): number | undefined => {
  const channelId = pendingVoiceReconnectChannelId;
  pendingVoiceReconnectChannelId = undefined;
  return channelId;
};

const clearPendingVoiceReconnectChannelId = (): void => {
  pendingVoiceReconnectChannelId = undefined;
};

export {
  clearPendingVoiceReconnectChannelId,
  consumePendingVoiceReconnectChannelId,
  setPendingVoiceReconnectChannelId
};
