import { describe, expect, it } from 'bun:test';
import { ScreenAudioMode } from '@/runtime/types';
import {
	getDefaultScreenShareIncludeAudio,
	getEffectiveScreenShareAudioMode,
	resolveAppAudioTargetBehavior,
} from '../resolve-app-audio-target';

describe('getDefaultScreenShareIncludeAudio', () => {
	it('defaults to on for shared-audio modes', () => {
		expect(getDefaultScreenShareIncludeAudio(ScreenAudioMode.SYSTEM)).toBe(true);
		expect(getDefaultScreenShareIncludeAudio(ScreenAudioMode.APP)).toBe(true);
	});

	it('defaults to off for no-audio mode', () => {
		expect(getDefaultScreenShareIncludeAudio(ScreenAudioMode.NONE)).toBe(false);
	});
});

describe('getEffectiveScreenShareAudioMode', () => {
	it('uses per-app audio for window shares when supported', () => {
		expect(
			getEffectiveScreenShareAudioMode({
				includeAudio: true,
				systemAudioSupported: true,
				perAppAudioSupported: true,
				sourceKind: 'window',
			}),
		).toBe(ScreenAudioMode.APP);
	});

	it('falls back to system audio for window shares when per-app audio is unsupported', () => {
		expect(
			getEffectiveScreenShareAudioMode({
				includeAudio: true,
				systemAudioSupported: true,
				perAppAudioSupported: false,
				sourceKind: 'window',
			}),
		).toBe(ScreenAudioMode.SYSTEM);
	});

	it('uses system audio for display shares when enabled', () => {
		expect(
			getEffectiveScreenShareAudioMode({
				includeAudio: true,
				systemAudioSupported: true,
				perAppAudioSupported: true,
				sourceKind: 'screen',
			}),
		).toBe(ScreenAudioMode.SYSTEM);
	});

	it('disables shared audio when the toggle is off', () => {
		expect(
			getEffectiveScreenShareAudioMode({
				includeAudio: false,
				systemAudioSupported: true,
				perAppAudioSupported: true,
				sourceKind: 'window',
			}),
		).toBe(ScreenAudioMode.NONE);
	});

	it('falls back to none when no audio capture path is supported', () => {
		expect(
			getEffectiveScreenShareAudioMode({
				includeAudio: true,
				systemAudioSupported: false,
				perAppAudioSupported: false,
				sourceKind: 'screen',
			}),
		).toBe(ScreenAudioMode.NONE);
	});
});

describe('resolveAppAudioTargetBehavior', () => {
	it('skips target resolution for screen shares in app mode', () => {
		const result = resolveAppAudioTargetBehavior({
			audioMode: ScreenAudioMode.APP,
			perAppAudioSupported: true,
			sourceKind: 'screen',
			availableTargetCount: 2,
			suggestedTargetId: undefined,
			requiresManualSelection: undefined,
		});

		expect(result.shouldResolveAppAudioTargets).toBe(false);
		expect(result.requiresManualAppAudioTarget).toBe(false);
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
