import { ScreenAudioMode } from '@/runtime/types';
import { describe, expect, it } from 'bun:test';
import { resolveAppAudioTargetBehavior } from '../resolve-app-audio-target';

describe('resolveAppAudioTargetBehavior', () => {
  it('requires manual target for screen shares in app mode', () => {
    const result = resolveAppAudioTargetBehavior({
      audioMode: ScreenAudioMode.APP,
      perAppAudioSupported: true,
      sourceKind: 'screen',
      suggestedTargetId: undefined
    });

    expect(result.shouldResolveAppAudioTargets).toBe(true);
    expect(result.requiresManualAppAudioTarget).toBe(true);
  });

  it('does not require manual target for mapped window shares', () => {
    const result = resolveAppAudioTargetBehavior({
      audioMode: ScreenAudioMode.APP,
      perAppAudioSupported: true,
      sourceKind: 'window',
      suggestedTargetId: 'pid:1234'
    });

    expect(result.shouldResolveAppAudioTargets).toBe(true);
    expect(result.requiresManualAppAudioTarget).toBe(false);
  });

  it('skips target resolution when app mode is not selected', () => {
    const result = resolveAppAudioTargetBehavior({
      audioMode: ScreenAudioMode.SYSTEM,
      perAppAudioSupported: true,
      sourceKind: 'window',
      suggestedTargetId: undefined
    });

    expect(result.shouldResolveAppAudioTargets).toBe(false);
    expect(result.requiresManualAppAudioTarget).toBe(false);
  });

  it('skips target resolution when per-app audio is unsupported', () => {
    const result = resolveAppAudioTargetBehavior({
      audioMode: ScreenAudioMode.APP,
      perAppAudioSupported: false,
      sourceKind: 'window',
      suggestedTargetId: undefined
    });

    expect(result.shouldResolveAppAudioTargets).toBe(false);
    expect(result.requiresManualAppAudioTarget).toBe(false);
  });
});
