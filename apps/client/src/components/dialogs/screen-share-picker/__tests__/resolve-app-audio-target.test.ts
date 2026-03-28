import { describe, expect, it } from 'bun:test';
import { ScreenAudioMode } from '@/runtime/types';
import { resolveAppAudioTargetBehavior } from '../resolve-app-audio-target';

describe('resolveAppAudioTargetBehavior', () => {
	it('requires manual target for screen shares in app mode', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.APP,
			perAppAudioSupported: true,
			sourceKind: 'screen',
			suggestedTargetId: undefined,
			requiresManualSelection: undefined,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(true);
		expect(result.requiresManualAppAudioTarget).toBe(true);
		expect(result.shouldAutoSelectSuggestedTarget).toBe(false);
	});

	it('does not require manual target for mapped window shares', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.APP,
			perAppAudioSupported: true,
			sourceKind: 'window',
			suggestedTargetId: 'pid:1234',
			requiresManualSelection: undefined,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(true);
		expect(result.requiresManualAppAudioTarget).toBe(false);
		expect(result.shouldAutoSelectSuggestedTarget).toBe(true);
	});

	it('honors explicit manual-selection requirements from the desktop bridge', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.APP,
			perAppAudioSupported: true,
			sourceKind: 'window',
			suggestedTargetId: 'pid:1234',
			requiresManualSelection: true,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(true);
		expect(result.requiresManualAppAudioTarget).toBe(true);
		expect(result.shouldAutoSelectSuggestedTarget).toBe(false);
	});

	it('skips target resolution when app mode is not selected', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.SYSTEM,
			perAppAudioSupported: true,
			sourceKind: 'window',
			suggestedTargetId: undefined,
			requiresManualSelection: undefined,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(false);
		expect(result.requiresManualAppAudioTarget).toBe(false);
		expect(result.shouldAutoSelectSuggestedTarget).toBe(false);
	});

	it('skips target resolution when per-app audio is unsupported', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.APP,
			perAppAudioSupported: false,
			sourceKind: 'window',
			suggestedTargetId: undefined,
			requiresManualSelection: undefined,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(false);
		expect(result.requiresManualAppAudioTarget).toBe(false);
		expect(result.shouldAutoSelectSuggestedTarget).toBe(false);
	});
});
