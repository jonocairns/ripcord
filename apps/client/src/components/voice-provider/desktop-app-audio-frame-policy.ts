import type { TAppAudioFrame, TAppAudioPcmFrame } from '@/runtime/types';

type TDesktopAppAudioFrame = TAppAudioFrame | TAppAudioPcmFrame;

type TDesktopAppAudioFrameDropReason =
  | 'session-mismatch'
  | 'unsupported-protocol'
  | 'unsupported-encoding'
  | 'sample-rate-mismatch'
  | 'invalid-sequence'
  | 'out-of-order-sequence'
  | 'malformed-header'
  | 'channel-mismatch';

type TDesktopAppAudioFrameValidationInput = {
  frame: TDesktopAppAudioFrame;
  sessionId: string;
  sessionSampleRate: number;
  outputChannels: number;
  lastSequence: number | undefined;
};

type TDesktopAppAudioFrameValidationResult =
  | {
      accepted: false;
      reason: TDesktopAppAudioFrameDropReason;
    }
  | {
      accepted: true;
      droppedFrameCount: number;
      sequenceGapFrames: number;
      missingFrameCount: number;
    };

const MAX_RECOVERABLE_DROPPED_FRAMES = 50;
const MAX_RECOVERABLE_SEQUENCE_GAP_FRAMES = 50;
const MAX_RECOVERABLE_MISSING_FRAMES = Math.max(
  MAX_RECOVERABLE_DROPPED_FRAMES,
  MAX_RECOVERABLE_SEQUENCE_GAP_FRAMES
);

const isPcmFrame = (frame: TDesktopAppAudioFrame): frame is TAppAudioPcmFrame => {
  return 'pcm' in frame && frame.pcm instanceof Float32Array && !('encoding' in frame);
};

const computeRecoverableMissingFrameCount = (missingFrameCount: number): number => {
  if (!Number.isFinite(missingFrameCount)) {
    return 0;
  }

  return Math.min(
    Math.max(0, Math.floor(missingFrameCount)),
    MAX_RECOVERABLE_MISSING_FRAMES
  );
};

const validateDesktopAppAudioFrame = ({
  frame,
  sessionId,
  sessionSampleRate,
  outputChannels,
  lastSequence
}: TDesktopAppAudioFrameValidationInput): TDesktopAppAudioFrameValidationResult => {
  if (frame.sessionId !== sessionId) {
    return {
      accepted: false,
      reason: 'session-mismatch'
    };
  }

  if (frame.protocolVersion !== 1) {
    return {
      accepted: false,
      reason: 'unsupported-protocol'
    };
  }

  if (!isPcmFrame(frame) && frame.encoding !== 'f32le_base64') {
    return {
      accepted: false,
      reason: 'unsupported-encoding'
    };
  }

  if (
    !Number.isInteger(frame.sampleRate) ||
    frame.sampleRate <= 0 ||
    frame.sampleRate !== sessionSampleRate
  ) {
    return {
      accepted: false,
      reason: 'sample-rate-mismatch'
    };
  }

  if (!Number.isInteger(frame.sequence) || frame.sequence < 0) {
    return {
      accepted: false,
      reason: 'invalid-sequence'
    };
  }

  let sequenceGapFrames = 0;
  if (lastSequence !== undefined) {
    if (frame.sequence <= lastSequence) {
      return {
        accepted: false,
        reason: 'out-of-order-sequence'
      };
    }

    sequenceGapFrames = Math.max(0, frame.sequence - (lastSequence + 1));
  }

  if (
    !Number.isInteger(frame.channels) ||
    frame.channels <= 0 ||
    !Number.isInteger(frame.frameCount) ||
    frame.frameCount <= 0
  ) {
    return {
      accepted: false,
      reason: 'malformed-header'
    };
  }

  if (frame.channels !== outputChannels) {
    return {
      accepted: false,
      reason: 'channel-mismatch'
    };
  }

  const droppedFrameCount = Number.isFinite(frame.droppedFrameCount)
    ? Math.max(0, Math.floor(frame.droppedFrameCount || 0))
    : 0;
  const missingFrameCount = Math.max(droppedFrameCount, sequenceGapFrames);

  return {
    accepted: true,
    droppedFrameCount,
    sequenceGapFrames,
    missingFrameCount
  };
};

export {
  computeRecoverableMissingFrameCount,
  isPcmFrame,
  validateDesktopAppAudioFrame
};
export type {
  TDesktopAppAudioFrame,
  TDesktopAppAudioFrameDropReason,
  TDesktopAppAudioFrameValidationInput,
  TDesktopAppAudioFrameValidationResult
};
