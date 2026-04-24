let simulatedOfflineExpiresAt: number | undefined;
let simulatedOfflineTimeoutId: number | undefined;

const clearSimulatedOfflineTimeout = () => {
	if (simulatedOfflineTimeoutId !== undefined) {
		window.clearTimeout(simulatedOfflineTimeoutId);
		simulatedOfflineTimeoutId = undefined;
	}
};

const isReconnectLabDebugEnabled = () => {
	return import.meta.env.DEV;
};

const isVoiceReconnectOfflineSimulated = (now = Date.now()): boolean => {
	if (!isReconnectLabDebugEnabled() || simulatedOfflineExpiresAt === undefined) {
		return false;
	}

	if (now >= simulatedOfflineExpiresAt) {
		simulatedOfflineExpiresAt = undefined;
		clearSimulatedOfflineTimeout();
		return false;
	}

	return true;
};

const isVoiceReconnectOnline = (now = Date.now()): boolean => {
	const browserOnline = typeof navigator === 'undefined' || navigator.onLine !== false;

	return browserOnline && !isVoiceReconnectOfflineSimulated(now);
};

const startVoiceReconnectOfflineSimulation = (durationMs: number): number | undefined => {
	if (!isReconnectLabDebugEnabled() || typeof window === 'undefined') {
		return undefined;
	}

	clearSimulatedOfflineTimeout();
	simulatedOfflineExpiresAt = Date.now() + durationMs;
	window.dispatchEvent(new Event('offline'));

	simulatedOfflineTimeoutId = window.setTimeout(() => {
		simulatedOfflineExpiresAt = undefined;
		simulatedOfflineTimeoutId = undefined;
		window.dispatchEvent(new Event('online'));
	}, durationMs);

	return simulatedOfflineExpiresAt;
};

const clearVoiceReconnectOfflineSimulation = () => {
	if (!isReconnectLabDebugEnabled() || typeof window === 'undefined') {
		return;
	}

	const wasActive = isVoiceReconnectOfflineSimulated();

	simulatedOfflineExpiresAt = undefined;
	clearSimulatedOfflineTimeout();

	if (wasActive) {
		window.dispatchEvent(new Event('online'));
	}
};

const getVoiceReconnectOfflineSimulationRemainingMs = (now = Date.now()) => {
	if (!isVoiceReconnectOfflineSimulated(now) || simulatedOfflineExpiresAt === undefined) {
		return 0;
	}

	return Math.max(simulatedOfflineExpiresAt - now, 0);
};

export {
	clearVoiceReconnectOfflineSimulation,
	getVoiceReconnectOfflineSimulationRemainingMs,
	isVoiceReconnectOfflineSimulated,
	isVoiceReconnectOnline,
	startVoiceReconnectOfflineSimulation,
};
