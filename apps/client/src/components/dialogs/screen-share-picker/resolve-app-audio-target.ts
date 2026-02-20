import {
  ScreenAudioMode,
  type TDesktopShareSourceKind
} from '@/runtime/types';

type TResolveAppAudioTargetBehaviorInput = {
  audioMode: ScreenAudioMode;
  perAppAudioSupported: boolean;
  sourceKind: TDesktopShareSourceKind | undefined;
  suggestedTargetId: string | undefined;
};

type TResolveAppAudioTargetBehaviorResult = {
  shouldResolveAppAudioTargets: boolean;
  requiresManualAppAudioTarget: boolean;
};

const resolveAppAudioTargetBehavior = ({
  audioMode,
  perAppAudioSupported,
  sourceKind,
  suggestedTargetId
}: TResolveAppAudioTargetBehaviorInput): TResolveAppAudioTargetBehaviorResult => {
  const shouldResolveAppAudioTargets =
    perAppAudioSupported && audioMode === ScreenAudioMode.APP && !!sourceKind;

  const requiresManualAppAudioTarget =
    shouldResolveAppAudioTargets &&
    (sourceKind === 'screen' || !suggestedTargetId);

  return {
    shouldResolveAppAudioTargets,
    requiresManualAppAudioTarget
  };
};

export { resolveAppAudioTargetBehavior };
export type {
  TResolveAppAudioTargetBehaviorInput,
  TResolveAppAudioTargetBehaviorResult
};
