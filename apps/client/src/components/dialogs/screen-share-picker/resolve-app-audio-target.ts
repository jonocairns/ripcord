import { ScreenAudioMode, type TDesktopShareSourceKind } from '@/runtime/types';

const getDefaultScreenShareIncludeAudio = (audioMode: ScreenAudioMode) => {
	return audioMode !== ScreenAudioMode.NONE;
};

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

const getEffectiveScreenShareAudioMode = ({
	includeAudio,
	systemAudioSupported,
	perAppAudioSupported,
	sourceKind,
}: {
	includeAudio: boolean;
	systemAudioSupported: boolean;
	perAppAudioSupported: boolean;
	sourceKind: TDesktopShareSourceKind | undefined;
}) => {
	if (!includeAudio || !sourceKind) {
		return ScreenAudioMode.NONE;
	}

	if (sourceKind === 'window' && perAppAudioSupported) {
		return ScreenAudioMode.APP;
	}

	if (systemAudioSupported) {
		return ScreenAudioMode.SYSTEM;
	}

	return ScreenAudioMode.NONE;
};

const resolveAppAudioTargetBehavior = ({
	audioMode,
	perAppAudioSupported,
	sourceKind,
	availableTargetCount,
	suggestedTargetId,
	requiresManualSelection,
}: TResolveAppAudioTargetBehaviorInput): TResolveAppAudioTargetBehaviorResult => {
	const shouldResolveAppAudioTargets =
		perAppAudioSupported && audioMode === ScreenAudioMode.APP && sourceKind === 'window';

	const requiresManualAppAudioTarget = shouldResolveAppAudioTargets && (requiresManualSelection ?? !suggestedTargetId);

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
export { getDefaultScreenShareIncludeAudio, getEffectiveScreenShareAudioMode, resolveAppAudioTargetBehavior };
