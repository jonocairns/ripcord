import { ScreenAudioMode, type TDesktopShareSourceKind } from '@/runtime/types';

// Sentinel value for the "System audio (all apps)" choice in the display
// per-app dropdown. It is never sent to the desktop bridge — it just means
// "don't isolate a specific app", which maps back to system audio.
const SYSTEM_AUDIO_TARGET_ID = '__system_audio__';

const isSpecificAppAudioTarget = (targetId: string | undefined): targetId is string =>
	targetId !== undefined && targetId !== SYSTEM_AUDIO_TARGET_ID;

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
	// Display shares have no window owner to infer audio from, so per-app is an
	// optional override over system audio: resolve the running-app list whenever
	// audio is enabled (mode is system by default), and never block confirm on it
	// — picking nothing simply keeps system audio.
	if (sourceKind === 'screen') {
		return {
			shouldResolveAppAudioTargets: perAppAudioSupported && audioMode !== ScreenAudioMode.NONE,
			requiresManualAppAudioTarget: false,
			shouldAutoSelectSuggestedTarget: false,
			allowsImplicitFallbackWithoutTarget: false,
		};
	}

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
export {
	getDefaultScreenShareIncludeAudio,
	getEffectiveScreenShareAudioMode,
	isSpecificAppAudioTarget,
	resolveAppAudioTargetBehavior,
	SYSTEM_AUDIO_TARGET_ID,
};
