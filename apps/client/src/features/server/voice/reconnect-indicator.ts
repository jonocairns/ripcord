const VOICE_RECONNECT_INDICATOR_DELAY_MS = 4_000;

const getVoiceReconnectIndicatorDelayMs = (reconnectingSince: number, now = Date.now()): number => {
	return Math.max(VOICE_RECONNECT_INDICATOR_DELAY_MS - (now - reconnectingSince), 0);
};

const shouldShowVoiceReconnectIndicator = (
	currentVoiceChannelId: number | undefined,
	reconnectingSince: number | undefined,
	now = Date.now(),
): boolean => {
	if (currentVoiceChannelId !== undefined || reconnectingSince === undefined) {
		return false;
	}

	return getVoiceReconnectIndicatorDelayMs(reconnectingSince, now) === 0;
};

export { getVoiceReconnectIndicatorDelayMs, shouldShowVoiceReconnectIndicator, VOICE_RECONNECT_INDICATOR_DELAY_MS };
