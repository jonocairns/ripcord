import { describe, expect, it } from 'bun:test';
import type { TMicrophonePipelineLifecycle } from '../../microphone-pipeline-controller';
import { mountMicrophonePipelineController } from '../use-microphone-pipeline-controller-lifecycle';

describe('microphone pipeline controller lifecycle adapter', () => {
	it('keeps a retained controller reusable across Strict Mode lifecycle replay', () => {
		const events: string[] = [];
		const controller: TMicrophonePipelineLifecycle = {
			activate: () => {
				events.push('activate');
			},
			deactivate: () => {
				events.push('deactivate');
				return Promise.resolve();
			},
		};

		const replayCleanup = mountMicrophonePipelineController(controller);
		replayCleanup();
		const finalCleanup = mountMicrophonePipelineController(controller);
		finalCleanup();
		finalCleanup();

		expect(events).toEqual(['activate', 'deactivate', 'activate', 'deactivate']);
	});
});
