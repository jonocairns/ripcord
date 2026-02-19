import { ScreenAudioMode } from '@/runtime/types';
import { describe, expect, it } from 'bun:test';
import { resolveAppAudioTargetBehavior } from '../resolve-app-audio-target';

describe('resolveAppAudioTargetBehavior', () => {
  it('requires manual target for screen shares in app mode', () => {
    const result = resolveAppAudioTargetBehavior({
      audioMode: ScreenAudioMode.APP,
      experimentalRustCapture: true,
      sourceKind: 'screen',
      suggestedTargetId: undefined
    });

    expect(result.shouldResolveAppAudioTargets).toBe(true);
    expect(result.requiresManualAppAudioTarget).toBe(true);
  });

  it('does not require manual target for mapped window shares', () => {
    const result = resolveAppAudioTargetBehavior({
      audioMode: ScreenAudioMode.APP,
      experimentalRustCapture: true,
      sourceKind: 'window',
      suggestedTargetId: 'pid:1234'
    });

    expect(result.shouldResolveAppAudioTargets).toBe(true);
    expect(result.requiresManualAppAudioTarget).toBe(false);
  });

  it('skips target resolution when experimental mode is disabled', () => {
    const result = resolveAppAudioTargetBehavior({
      audioMode: ScreenAudioMode.APP,
      experimentalRustCapture: false,
      sourceKind: 'window',
      suggestedTargetId: undefined
    });

    expect(result.shouldResolveAppAudioTargets).toBe(false);
    expect(result.requiresManualAppAudioTarget).toBe(false);
  });
});
