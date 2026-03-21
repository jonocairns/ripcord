type TAudioContextConstructor<TAudioContextInstance> = new (
	contextOptions?: AudioContextOptions,
) => TAudioContextInstance;

type TCreateAudioContextWithSampleRateFallbackInput<TAudioContextInstance> = {
	AudioContextClass: TAudioContextConstructor<TAudioContextInstance>;
	sampleRate: number;
	onPreferredSampleRateError?: (error: unknown) => void;
	onFallbackError?: (error: unknown) => void;
};

const createAudioContextWithSampleRateFallback = <TAudioContextInstance>({
	AudioContextClass,
	sampleRate,
	onPreferredSampleRateError,
	onFallbackError,
}: TCreateAudioContextWithSampleRateFallbackInput<TAudioContextInstance>): TAudioContextInstance | undefined => {
	try {
		return new AudioContextClass({ sampleRate });
	} catch (error) {
		onPreferredSampleRateError?.(error);
	}

	try {
		return new AudioContextClass();
	} catch (error) {
		onFallbackError?.(error);
		return undefined;
	}
};

export { createAudioContextWithSampleRateFallback };
