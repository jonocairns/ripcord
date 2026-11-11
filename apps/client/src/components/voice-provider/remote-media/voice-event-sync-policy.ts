const shouldStartProtectedVoiceEventSubscriptions = (
	reconnectingSince: number | undefined,
	sessionReady: boolean,
): boolean => reconnectingSince === undefined || sessionReady;

const shouldSyncExistingProducersAfterVoiceEventSubscriptionStart = (
	reconnectingSince: number | undefined,
): boolean => {
	return reconnectingSince === undefined;
};

export { shouldStartProtectedVoiceEventSubscriptions, shouldSyncExistingProducersAfterVoiceEventSubscriptionStart };
