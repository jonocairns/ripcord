type TDesktopAppAudioPipelineMode = 'low-latency' | 'stable';

type TDesktopAppAudioQueueConfig = {
	targetChunks: number;
	trimStartChunks: number;
	maxChunks: number;
	// Once the queue creeps up to this many chunks, snap it back to target. This
	// is the gentle drift correction for stable mode (0 disables it); without it
	// clock drift would pin the queue at maxChunks, adding permanent latency.
	resyncStartChunks: number;
	trimQueueForLowLatency: boolean;
};

const LOW_LATENCY_TARGET_CHUNKS = 3;
const LOW_LATENCY_TRIM_START_CHUNKS = 6;
const LOW_LATENCY_MAX_CHUNKS = 10;
const STABLE_TARGET_CHUNKS = 12;
const STABLE_MAX_CHUNKS = 24;
// Sits between target (12) and max (24): high enough to absorb bursts without
// resyncing constantly, low enough that latency never pins at the ceiling.
const STABLE_RESYNC_START_CHUNKS = 20;
const DEFAULT_DESKTOP_APP_AUDIO_PIPELINE_MODE: TDesktopAppAudioPipelineMode = 'stable';

const getDesktopAppAudioQueueConfig = (mode: TDesktopAppAudioPipelineMode): TDesktopAppAudioQueueConfig => {
	if (mode === 'stable') {
		return {
			targetChunks: STABLE_TARGET_CHUNKS,
			trimStartChunks: STABLE_MAX_CHUNKS,
			maxChunks: STABLE_MAX_CHUNKS,
			resyncStartChunks: STABLE_RESYNC_START_CHUNKS,
			trimQueueForLowLatency: false,
		};
	}

	return {
		targetChunks: LOW_LATENCY_TARGET_CHUNKS,
		trimStartChunks: LOW_LATENCY_TRIM_START_CHUNKS,
		maxChunks: LOW_LATENCY_MAX_CHUNKS,
		// Low-latency already trims aggressively via trimQueueForLowLatency.
		resyncStartChunks: 0,
		trimQueueForLowLatency: true,
	};
};

export type { TDesktopAppAudioPipelineMode, TDesktopAppAudioQueueConfig };
export { DEFAULT_DESKTOP_APP_AUDIO_PIPELINE_MODE, getDesktopAppAudioQueueConfig };
