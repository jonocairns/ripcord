const logVoice = (...args: unknown[]) => {
	console.log('%c[VOICE-PROVIDER]', 'color: salmon; font-weight: bold;', ...args);
};

const OVERRIDE_DEBUG = false;

const logDebug = (...args: unknown[]) => {
	const debugEnabled = typeof window !== 'undefined' && window.DEBUG;

	if (debugEnabled || OVERRIDE_DEBUG) {
		console.log('%c[DEBUG]', 'color: lightblue; font-weight: bold;', ...args);
	}
};

export { logDebug, logVoice };
