const shouldSyncExistingProducersAfterVoiceEventSubscriptionStart = (
	reconnectingSince: number | undefined,
): boolean => {
	return reconnectingSince === undefined;
};

export { shouldSyncExistingProducersAfterVoiceEventSubscriptionStart };
