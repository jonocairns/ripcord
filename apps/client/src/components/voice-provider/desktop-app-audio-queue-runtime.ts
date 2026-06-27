type TPcmQueueAdmissionConfig = {
	targetChunks: number;
	trimStartChunks: number;
	maxChunks: number;
	resyncStartChunks: number;
	trimQueueForLowLatency: boolean;
};

type TPcmQueueAdmissionReason = 'overflow' | 'low-latency-trim' | 'resync' | 'none';

type TPcmQueueAdmissionPlan = {
	dropCount: number;
	reason: TPcmQueueAdmissionReason;
};

/**
 * Decides how many queued chunks to drop from the front before admitting a newly
 * arrived chunk, given the queue length observed just before the push.
 *
 * This is the canonical implementation. The audio worklet inlines the same
 * arithmetic because it is loaded as a raw module URL and cannot import bundled
 * code — keep the two in sync (the worklet references this file by name).
 */
const planPcmQueueAdmission = (queueLength: number, config: TPcmQueueAdmissionConfig): TPcmQueueAdmissionPlan => {
	const { targetChunks, trimStartChunks, maxChunks, resyncStartChunks, trimQueueForLowLatency } = config;

	const dropToTarget = Math.max(0, queueLength - (targetChunks - 1));

	// Hard ceiling: make room for the incoming chunk without exceeding maxChunks.
	if (queueLength >= maxChunks) {
		return { dropCount: Math.max(0, queueLength - (maxChunks - 1)), reason: 'overflow' };
	}

	// Low-latency: snap straight back to target whenever the line grows.
	if (trimQueueForLowLatency && queueLength >= trimStartChunks) {
		return { dropCount: dropToTarget, reason: 'low-latency-trim' };
	}

	// Stable: clock drift slowly fills the queue. Once it has crept up to the
	// resync threshold, snap back to target so latency can't pin at the ceiling.
	if (resyncStartChunks > 0 && queueLength >= resyncStartChunks) {
		return { dropCount: dropToTarget, reason: 'resync' };
	}

	return { dropCount: 0, reason: 'none' };
};

export type { TPcmQueueAdmissionConfig, TPcmQueueAdmissionPlan, TPcmQueueAdmissionReason };
export { planPcmQueueAdmission };
