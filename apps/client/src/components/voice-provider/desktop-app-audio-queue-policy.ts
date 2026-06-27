type TDesktopAppAudioPipelineMode = 'low-latency' | 'stable';

type TDesktopAppAudioQueueConfig = {
	targetChunks: number;
	trimStartChunks: number;
	maxChunks: number;
	trimQueueForLowLatency: boolean;
};

const LOW_LATENCY_TARGET_CHUNKS = 3;
const LOW_LATENCY_TRIM_START_CHUNKS = 6;
const LOW_LATENCY_MAX_CHUNKS = 10;
const STABLE_TARGET_CHUNKS = 12;
const STABLE_MAX_CHUNKS = 24;
const DEFAULT_DESKTOP_APP_AUDIO_PIPELINE_MODE: TDesktopAppAudioPipelineMode = 'stable';

const getDesktopAppAudioQueueConfig = (mode: TDesktopAppAudioPipelineMode): TDesktopAppAudioQueueConfig => {
	if (mode === 'stable') {
		return {
			targetChunks: STABLE_TARGET_CHUNKS,
			trimStartChunks: STABLE_MAX_CHUNKS,
			maxChunks: STABLE_MAX_CHUNKS,
			trimQueueForLowLatency: false,
		};
	}

	return {
		targetChunks: LOW_LATENCY_TARGET_CHUNKS,
		trimStartChunks: LOW_LATENCY_TRIM_START_CHUNKS,
		maxChunks: LOW_LATENCY_MAX_CHUNKS,
		trimQueueForLowLatency: true,
	};
};

export type { TDesktopAppAudioPipelineMode, TDesktopAppAudioQueueConfig };
export { DEFAULT_DESKTOP_APP_AUDIO_PIPELINE_MODE, getDesktopAppAudioQueueConfig };
