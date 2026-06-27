import { describe, expect, it } from 'bun:test';
import { getDesktopAppAudioQueueConfig } from '../desktop-app-audio-queue-policy';
import { planPcmQueueAdmission, type TPcmQueueAdmissionConfig } from '../desktop-app-audio-queue-runtime';

const stable: TPcmQueueAdmissionConfig = getDesktopAppAudioQueueConfig('stable');
const lowLatency: TPcmQueueAdmissionConfig = getDesktopAppAudioQueueConfig('low-latency');

// Length after the surviving chunks plus the one about to be pushed.
const resultingLength = (queueLength: number, dropCount: number) => queueLength - dropCount + 1;

describe('planPcmQueueAdmission — stable mode', () => {
	it('does nothing while the queue is below the resync threshold', () => {
		expect(planPcmQueueAdmission(stable.resyncStartChunks - 1, stable)).toEqual({ dropCount: 0, reason: 'none' });
	});

	it('resyncs back to target once the queue creeps up to the resync threshold', () => {
		const plan = planPcmQueueAdmission(stable.resyncStartChunks, stable);

		expect(plan.reason).toBe('resync');
		expect(resultingLength(stable.resyncStartChunks, plan.dropCount)).toBe(stable.targetChunks);
	});

	it('keeps the queue from pinning at the ceiling under sustained drift', () => {
		// Simulate one-chunk-at-a-time arrival faster than playback drains.
		let queueLength = stable.targetChunks;
		let peak = queueLength;

		for (let push = 0; push < 200; push += 1) {
			const plan = planPcmQueueAdmission(queueLength, stable);
			queueLength = resultingLength(queueLength, plan.dropCount);
			peak = Math.max(peak, queueLength);
			// drift: producer adds slightly faster than the consumer removes
			queueLength += 1;
		}

		expect(peak).toBeLessThanOrEqual(stable.resyncStartChunks);
		expect(peak).toBeLessThan(stable.maxChunks);
	});

	it('falls back to overflow if the queue somehow reaches max', () => {
		const plan = planPcmQueueAdmission(stable.maxChunks, stable);

		expect(plan.reason).toBe('overflow');
		expect(resultingLength(stable.maxChunks, plan.dropCount)).toBe(stable.maxChunks);
	});
});

describe('planPcmQueueAdmission — low-latency mode', () => {
	it('does not resync (resync is disabled)', () => {
		expect(lowLatency.resyncStartChunks).toBe(0);
		const plan = planPcmQueueAdmission(lowLatency.maxChunks - 1, lowLatency);
		expect(plan.reason).not.toBe('resync');
	});

	it('trims aggressively back to target once past the trim-start threshold', () => {
		const plan = planPcmQueueAdmission(lowLatency.trimStartChunks, lowLatency);

		expect(plan.reason).toBe('low-latency-trim');
		expect(resultingLength(lowLatency.trimStartChunks, plan.dropCount)).toBe(lowLatency.targetChunks);
	});
});
