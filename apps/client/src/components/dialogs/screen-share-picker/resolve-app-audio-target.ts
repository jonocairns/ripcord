import { ScreenAudioMode, type TDesktopShareSourceKind } from '@/runtime/types';

type TResolveAppAudioTargetBehaviorInput = {
	audioMode: ScreenAudioMode;
	perAppAudioSupported: boolean;
	sourceKind: TDesktopShareSourceKind | undefined;
	suggestedTargetId: string | undefined;
	requiresManualSelection: boolean | undefined;
};

type TResolveAppAudioTargetBehaviorResult = {
	shouldResolveAppAudioTargets: boolean;
	requiresManualAppAudioTarget: boolean;
	shouldAutoSelectSuggestedTarget: boolean;
};

const resolveAppAudioTargetBehavior = ({
	audioMode,
	perAppAudioSupported,
	sourceKind,
	suggestedTargetId,
	requiresManualSelection,
}: TResolveAppAudioTargetBehaviorInput): TResolveAppAudioTargetBehaviorResult => {
	const shouldResolveAppAudioTargets = perAppAudioSupported && audioMode === ScreenAudioMode.APP && !!sourceKind;

	const requiresManualAppAudioTarget =
		shouldResolveAppAudioTargets && (requiresManualSelection ?? (sourceKind === 'screen' || !suggestedTargetId));

	const shouldAutoSelectSuggestedTarget =
		shouldResolveAppAudioTargets && !requiresManualAppAudioTarget && !!suggestedTargetId;

	return {
		shouldResolveAppAudioTargets,
		requiresManualAppAudioTarget,
		shouldAutoSelectSuggestedTarget,
	};
};

export type { TResolveAppAudioTargetBehaviorInput, TResolveAppAudioTargetBehaviorResult };
export { resolveAppAudioTargetBehavior };
