import { ScreenAudioMode, type TDesktopShareSourceKind } from '@/runtime/types';

type TResolveAppAudioTargetBehaviorInput = {
	audioMode: ScreenAudioMode;
	perAppAudioSupported: boolean;
	sourceKind: TDesktopShareSourceKind | undefined;
	availableTargetCount: number;
	suggestedTargetId: string | undefined;
	requiresManualSelection: boolean | undefined;
};

type TResolveAppAudioTargetBehaviorResult = {
	shouldResolveAppAudioTargets: boolean;
	requiresManualAppAudioTarget: boolean;
	shouldAutoSelectSuggestedTarget: boolean;
	allowsImplicitFallbackWithoutTarget: boolean;
};

const resolveAppAudioTargetBehavior = ({
	audioMode,
	perAppAudioSupported,
	sourceKind,
	availableTargetCount,
	suggestedTargetId,
	requiresManualSelection,
}: TResolveAppAudioTargetBehaviorInput): TResolveAppAudioTargetBehaviorResult => {
	const shouldResolveAppAudioTargets = perAppAudioSupported && audioMode === ScreenAudioMode.APP && !!sourceKind;

	const requiresManualAppAudioTarget =
		shouldResolveAppAudioTargets && (requiresManualSelection ?? (sourceKind === 'screen' || !suggestedTargetId));

	const shouldAutoSelectSuggestedTarget =
		shouldResolveAppAudioTargets && !requiresManualAppAudioTarget && !!suggestedTargetId;
	const allowsImplicitFallbackWithoutTarget =
		shouldResolveAppAudioTargets && requiresManualAppAudioTarget && availableTargetCount === 0;

	return {
		shouldResolveAppAudioTargets,
		requiresManualAppAudioTarget,
		shouldAutoSelectSuggestedTarget,
		allowsImplicitFallbackWithoutTarget,
	};
};

export type { TResolveAppAudioTargetBehaviorInput, TResolveAppAudioTargetBehaviorResult };
export { resolveAppAudioTargetBehavior };
