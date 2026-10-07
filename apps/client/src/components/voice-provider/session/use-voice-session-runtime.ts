import { useEffect, useLayoutEffect, useRef } from 'react';
import { setVoiceProviderCleanupHandler } from '@/features/server/voice/provider-cleanup';
import { logVoice } from '@/helpers/browser-logger';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { isDesktopRuntime } from '@/runtime/desktop-bridge';
import { prewarmVoiceEngines } from './prewarm';
import { useVoiceSessionExecutor } from './use-voice-session-executor';
import {
	createVoiceSessionRuntime,
	mountVoiceSessionRuntime,
	type TVoiceSessionRuntimeDependencies,
} from './voice-session-runtime';
import {
	voiceSessionRuntimeEnvironment,
	voiceSessionRuntimeExecutorEnvironment,
} from './voice-session-runtime-environment';

type TUseVoiceSessionRuntimeParams = Pick<
	TVoiceSessionRuntimeDependencies,
	| 'microphone'
	| 'webcam'
	| 'screenShare'
	| 'shareAudio'
	| 'getLocalAudioStream'
	| 'getProducerTransport'
	| 'getConsumerTransport'
	| 'createProducerTransport'
	| 'createConsumerTransport'
	| 'consumeExistingProducers'
	| 'cleanupTransports'
	| 'clearRemoteUserStreams'
	| 'clearExternalStreams'
	| 'clearMediaElementRefs'
	| 'clearActivity'
	| 'startMonitoring'
	| 'stopMonitoring'
	| 'resetStats'
	| 'deviceRtpCapabilities'
	| 'transportFailures'
	| 'publishRtpCapabilities'
	| 'captureWatchedRemoteStreams'
	| 'rehydrateWatchIntentOnly'
> & {
	currentVoiceChannelId: number | undefined;
	isConnected: boolean;
	voiceSessionReconnectNonce: number;
	canSpeak: boolean;
};

const useVoiceSessionRuntime = (inputs: TUseVoiceSessionRuntimeParams) => {
	const inputsRef = useLatestRef(inputs);
	const runtimeRef = useRef<ReturnType<typeof createVoiceSessionRuntime> | undefined>(undefined);
	if (!runtimeRef.current) {
		runtimeRef.current = createVoiceSessionRuntime(() => ({
			...inputsRef.current,
			getChannelId: () => inputsRef.current.currentVoiceChannelId,
			isConnected: () => inputsRef.current.isConnected,
			getReconnectNonce: () => inputsRef.current.voiceSessionReconnectNonce,
			canSpeak: () => inputsRef.current.canSpeak,
			...voiceSessionRuntimeEnvironment,
		}));
	}
	const runtime = runtimeRef.current;
	// Fence concrete effects before passive executor setup and cleanup. Retained
	// instances reactivate during Strict Mode replay without acquiring media.
	useLayoutEffect(() => mountVoiceSessionRuntime(runtime), [runtime]);
	useEffect(() => {
		void inputs.currentVoiceChannelId;
		runtime.syncChannel();
	}, [runtime, inputs.currentVoiceChannelId]);
	useEffect(() => {
		setVoiceProviderCleanupHandler(runtime.terminalCleanup);
		return () => {
			setVoiceProviderCleanupHandler(undefined);
		};
	}, [runtime]);
	useEffect(() => {
		if (isDesktopRuntime()) prewarmVoiceEngines({ warmMicrophoneIfGranted: true });
	}, []);
	useVoiceSessionExecutor({
		...voiceSessionRuntimeExecutorEnvironment,
		captureRecoverySnapshot: runtime.captureRecoverySnapshot,
		rebuildTransports: runtime.rebuildTransports,
		restoreVoiceSession: runtime.restoreVoiceSession,
		restoreWatchIntent: runtime.restoreWatchIntent,
		recoverDesktopAppAudio: runtime.recoverDesktopAppAudio,
		onRebuildSucceeded: runtime.onRecoverySucceeded,
		onReconnectSucceeded: runtime.onRecoverySucceeded,
		leaveVoiceSession: runtime.leaveVoiceSession,
		clearFailedSession: runtime.clearFailedSession,
	});

	useEffect(
		() => () => {
			logVoice('Voice provider unmounting, cleaning up resources');
			runtime.terminalCleanup();
		},
		[runtime],
	);
	return runtime;
};

export { useVoiceSessionRuntime };
