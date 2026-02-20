import { describe, expect, it } from 'bun:test';
import type { TAppAudioFrame } from '@/runtime/types';
import {
  computeRecoverableMissingFrameCount,
  validateDesktopAppAudioFrame
} from '../desktop-app-audio-frame-policy';

const createFrame = (overrides: Partial<TAppAudioFrame> = {}): TAppAudioFrame => {
  return {
    sessionId: 'session-1',
    targetId: 'pid:1234',
    sequence: 1,
    sampleRate: 48_000,
    channels: 2,
    frameCount: 960,
    pcmBase64: 'AAAAAA==',
    protocolVersion: 1,
    encoding: 'f32le_base64',
    droppedFrameCount: 0,
    ...overrides
  };
};

describe('desktop app audio frame policy', () => {
  it('drops frames with sample-rate mismatch', () => {
    const result = validateDesktopAppAudioFrame({
      frame: createFrame({
        sampleRate: 44_100
      }),
      sessionId: 'session-1',
      sessionSampleRate: 48_000,
      outputChannels: 2,
      lastSequence: undefined
    });

    expect(result).toEqual({
      accepted: false,
      reason: 'sample-rate-mismatch'
    });
  });

  it('drops invalid and out-of-order sequences', () => {
    const invalidSequence = validateDesktopAppAudioFrame({
      frame: createFrame({
        sequence: -1
      }),
      sessionId: 'session-1',
      sessionSampleRate: 48_000,
      outputChannels: 2,
      lastSequence: undefined
    });

    expect(invalidSequence).toEqual({
      accepted: false,
      reason: 'invalid-sequence'
    });

    const outOfOrder = validateDesktopAppAudioFrame({
      frame: createFrame({
        sequence: 9
      }),
      sessionId: 'session-1',
      sessionSampleRate: 48_000,
      outputChannels: 2,
      lastSequence: 10
    });

    expect(outOfOrder).toEqual({
      accepted: false,
      reason: 'out-of-order-sequence'
    });
  });

  it('computes sequence gaps and missing frame counts', () => {
    const result = validateDesktopAppAudioFrame({
      frame: createFrame({
        sequence: 15,
        droppedFrameCount: 2.9
      }),
      sessionId: 'session-1',
      sessionSampleRate: 48_000,
      outputChannels: 2,
      lastSequence: 10
    });

    expect(result).toEqual({
      accepted: true,
      droppedFrameCount: 2,
      sequenceGapFrames: 4,
      missingFrameCount: 4
    });
  });

  it('caps recoverable frame insertion for large gaps', () => {
    expect(computeRecoverableMissingFrameCount(0)).toBe(0);
    expect(computeRecoverableMissingFrameCount(12.9)).toBe(12);
    expect(computeRecoverableMissingFrameCount(50)).toBe(50);
    expect(computeRecoverableMissingFrameCount(500)).toBe(50);
  });
});
