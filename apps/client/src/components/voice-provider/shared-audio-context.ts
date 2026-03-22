import { createAudioContextWithSampleRateFallback } from './audio-context';

type TAcquireSharedVoiceAudioContextOptions = {
	onPreferredSampleRateError?: (error: unknown) => void;
	onFallbackError?: (error: unknown) => void;
};

let sharedVoiceAudioContext: AudioContext | null = null;
let sharedVoiceAudioContextUsers = 0;

const getAudioContextClass = () => {
	return (
		window.AudioContext ||
		(
			window as typeof window & {
				webkitAudioContext?: typeof AudioContext;
			}
		).webkitAudioContext
	);
};

const acquireSharedVoiceAudioContext = (options: TAcquireSharedVoiceAudioContextOptions = {}) => {
	if (sharedVoiceAudioContext && sharedVoiceAudioContext.state !== 'closed') {
		sharedVoiceAudioContextUsers++;
		return sharedVoiceAudioContext;
	}

	const AudioContextClass = getAudioContextClass();

	if (!AudioContextClass) {
		return undefined;
	}

	const audioContext = createAudioContextWithSampleRateFallback({
		AudioContextClass,
		sampleRate: 48_000,
		onPreferredSampleRateError: options.onPreferredSampleRateError,
		onFallbackError: options.onFallbackError,
	});

	if (!audioContext) {
		return undefined;
	}

	sharedVoiceAudioContext = audioContext;
	sharedVoiceAudioContextUsers = 1;

	return sharedVoiceAudioContext;
};

const releaseSharedVoiceAudioContext = (audioContext: AudioContext) => {
	// Only release the currently shared instance. Stale callers must not affect
	// the ref count if the browser closed the context and a new one was created.
	if (audioContext !== sharedVoiceAudioContext) {
		return;
	}

	sharedVoiceAudioContextUsers--;

	if (sharedVoiceAudioContextUsers > 0) {
		return;
	}

	void sharedVoiceAudioContext.close().catch(() => {
		// Closing an already-closed context is safe to ignore.
	});
	sharedVoiceAudioContext = null;
	sharedVoiceAudioContextUsers = 0;
};

export { acquireSharedVoiceAudioContext, releaseSharedVoiceAudioContext };
