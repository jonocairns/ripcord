import { describe, expect, it } from 'bun:test';
import { createAudioContextWithSampleRateFallback } from '../audio-context';

describe('createAudioContextWithSampleRateFallback', () => {
	it('falls back to the browser default context when the preferred sample rate is unsupported', () => {
		const constructorCalls: Array<AudioContextOptions | undefined> = [];
		const preferredSampleRateErrors: unknown[] = [];

		class FakeAudioContext {
			constructor(options?: AudioContextOptions) {
				constructorCalls.push(options);

				if (options?.sampleRate === 48_000) {
					const error = new Error('Unsupported sample rate');
					error.name = 'NotSupportedError';
					throw error;
				}
			}
		}

		const audioContext = createAudioContextWithSampleRateFallback({
			AudioContextClass: FakeAudioContext,
			sampleRate: 48_000,
			onPreferredSampleRateError: (error) => {
				preferredSampleRateErrors.push(error);
			},
		});

		expect(audioContext).toBeInstanceOf(FakeAudioContext);
		expect(constructorCalls).toEqual([{ sampleRate: 48_000 }, undefined]);
		expect(preferredSampleRateErrors).toHaveLength(1);
	});

	it('returns undefined when both the preferred and fallback context constructors fail', () => {
		const fallbackErrors: unknown[] = [];

		class FailingAudioContext {
			constructor(_options?: AudioContextOptions) {
				throw new Error('constructor failed');
			}
		}

		const audioContext = createAudioContextWithSampleRateFallback({
			AudioContextClass: FailingAudioContext,
			sampleRate: 48_000,
			onFallbackError: (error) => {
				fallbackErrors.push(error);
			},
		});

		expect(audioContext).toBeUndefined();
		expect(fallbackErrors).toHaveLength(1);
	});
});
