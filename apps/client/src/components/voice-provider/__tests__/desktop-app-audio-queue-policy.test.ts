import { describe, expect, it } from 'bun:test';
import {
	DEFAULT_DESKTOP_APP_AUDIO_PIPELINE_MODE,
	getDesktopAppAudioQueueConfig,
} from '../desktop-app-audio-queue-policy';

describe('desktop app audio queue policy', () => {
	it('defaults to stable mode for jitter-heavy desktop audio capture', () => {
		expect(DEFAULT_DESKTOP_APP_AUDIO_PIPELINE_MODE).toBe('stable');
	});

	it('keeps low-latency mode available as an opt-in small sidecar-frame budget', () => {
		const config = getDesktopAppAudioQueueConfig('low-latency');

		expect(config).toEqual({
			targetChunks: 3,
			trimStartChunks: 6,
			maxChunks: 10,
			trimQueueForLowLatency: true,
		});
	});

	it('keeps stable mode available for jitter-heavy diagnostics', () => {
		const config = getDesktopAppAudioQueueConfig('stable');

		expect(config).toEqual({
			targetChunks: 12,
			trimStartChunks: 24,
			maxChunks: 24,
			trimQueueForLowLatency: false,
		});
	});
});
