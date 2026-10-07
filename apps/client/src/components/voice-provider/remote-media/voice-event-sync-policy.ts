const shouldStartProtectedVoiceEventSubscriptions = (
	reconnectingSince: number | undefined,
	reconnectAuthenticated: boolean,
): boolean => reconnectingSince === undefined || reconnectAuthenticated;

const shouldSyncExistingProducersAfterVoiceEventSubscriptionStart = (
	reconnectingSince: number | undefined,
): boolean => {
	return reconnectingSince === undefined;
};

export { shouldStartProtectedVoiceEventSubscriptions, shouldSyncExistingProducersAfterVoiceEventSubscriptionStart };
