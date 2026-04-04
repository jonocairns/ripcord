import { describe, expect, it } from 'bun:test';
import { ScreenAudioMode } from '@/runtime/types';
import { getEffectiveScreenShareAudioMode, resolveAppAudioTargetBehavior } from '../resolve-app-audio-target';

describe('getEffectiveScreenShareAudioMode', () => {
	it('forces per-app audio for window shares when supported', () => {
		expect(
			getEffectiveScreenShareAudioMode({
				requestedAudioMode: ScreenAudioMode.SYSTEM,
				perAppAudioSupported: true,
				sourceKind: 'window',
			}),
		).toBe(ScreenAudioMode.APP);
	});

	it('preserves the requested mode when per-app audio is unsupported', () => {
		expect(
			getEffectiveScreenShareAudioMode({
				requestedAudioMode: ScreenAudioMode.SYSTEM,
				perAppAudioSupported: false,
				sourceKind: 'window',
			}),
		).toBe(ScreenAudioMode.SYSTEM);
	});

	it('preserves the requested mode for display shares', () => {
		expect(
			getEffectiveScreenShareAudioMode({
				requestedAudioMode: ScreenAudioMode.SYSTEM,
				perAppAudioSupported: true,
				sourceKind: 'screen',
			}),
		).toBe(ScreenAudioMode.SYSTEM);
	});
});

describe('resolveAppAudioTargetBehavior', () => {
	it('requires manual target for screen shares in app mode', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.APP,
			perAppAudioSupported: true,
			sourceKind: 'screen',
			availableTargetCount: 2,
			suggestedTargetId: undefined,
			requiresManualSelection: undefined,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(true);
		expect(result.requiresManualAppAudioTarget).toBe(true);
		expect(result.shouldAutoSelectSuggestedTarget).toBe(false);
		expect(result.allowsImplicitFallbackWithoutTarget).toBe(false);
	});

	it('does not require manual target for mapped window shares', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.APP,
			perAppAudioSupported: true,
			sourceKind: 'window',
			availableTargetCount: 1,
			suggestedTargetId: 'pid:1234',
			requiresManualSelection: undefined,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(true);
		expect(result.requiresManualAppAudioTarget).toBe(false);
		expect(result.shouldAutoSelectSuggestedTarget).toBe(true);
		expect(result.allowsImplicitFallbackWithoutTarget).toBe(false);
	});

	it('honors explicit manual-selection requirements from the desktop bridge', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.APP,
			perAppAudioSupported: true,
			sourceKind: 'window',
			availableTargetCount: 1,
			suggestedTargetId: 'pid:1234',
			requiresManualSelection: true,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(true);
		expect(result.requiresManualAppAudioTarget).toBe(true);
		expect(result.shouldAutoSelectSuggestedTarget).toBe(false);
		expect(result.allowsImplicitFallbackWithoutTarget).toBe(false);
	});

	it('skips target resolution when app mode is not selected', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.SYSTEM,
			perAppAudioSupported: true,
			sourceKind: 'window',
			availableTargetCount: 0,
			suggestedTargetId: undefined,
			requiresManualSelection: undefined,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(false);
		expect(result.requiresManualAppAudioTarget).toBe(false);
		expect(result.shouldAutoSelectSuggestedTarget).toBe(false);
		expect(result.allowsImplicitFallbackWithoutTarget).toBe(false);
	});

	it('skips target resolution when per-app audio is unsupported', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.APP,
			perAppAudioSupported: false,
			sourceKind: 'window',
			availableTargetCount: 0,
			suggestedTargetId: undefined,
			requiresManualSelection: undefined,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(false);
		expect(result.requiresManualAppAudioTarget).toBe(false);
		expect(result.shouldAutoSelectSuggestedTarget).toBe(false);
		expect(result.allowsImplicitFallbackWithoutTarget).toBe(false);
	});

	it('allows fallback when per-app audio has no available targets to choose from', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.APP,
			perAppAudioSupported: true,
			sourceKind: 'window',
			availableTargetCount: 0,
			suggestedTargetId: undefined,
			requiresManualSelection: true,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(true);
		expect(result.requiresManualAppAudioTarget).toBe(true);
		expect(result.shouldAutoSelectSuggestedTarget).toBe(false);
		expect(result.allowsImplicitFallbackWithoutTarget).toBe(true);
	});
});
