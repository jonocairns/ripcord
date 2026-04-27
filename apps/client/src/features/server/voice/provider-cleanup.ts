let voiceProviderCleanup: (() => void) | undefined;

const setVoiceProviderCleanupHandler = (cleanup: (() => void) | undefined): void => {
	voiceProviderCleanup = cleanup;
};

const runVoiceProviderCleanup = (): void => {
	voiceProviderCleanup?.();
};

export { runVoiceProviderCleanup, setVoiceProviderCleanupHandler };
