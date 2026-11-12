import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useServerStore } from '@/features/server/slice';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import {
	cancelOwnPushHold,
	sendOwnVoiceStateUpdate,
	setOwnVoiceIntent,
	updateOwnVoiceState,
} from '@/features/server/voice/actions';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import { resolveOwnVoiceState } from '@/features/server/voice/own-voice-state';
import { ownMicWantedSelector, ownVoiceStateSelector } from '@/features/server/voice/selectors';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useLatestRef } from '@/hooks/use-latest-ref';
import type { TDesktopScreenShareSelection } from '@/runtime/types';
import type { TMicrophoneStartOutcome } from './microphone/microphone-pipeline-controller';
import { createOwnMicControls } from './own-mic-controls';
import { VoiceSessionExecutionSupersededError } from './session-execution-ownership';
import { settleSupersededScreenShareStart } from './video/screen-share-control-lifecycle';
import { useScreenShareStage } from './video/use-screen-share-stage';
import type { TVoiceStateOperations } from './voice-state-operation';

type TUseVoiceControlsParams = {
	voiceStateOperations: TVoiceStateOperations;
	startMicStream: () => Promise<TMicrophoneStartOutcome>;
	hasLiveMicCapture: () => boolean;
	captureMicSession: () => () => boolean;
	resetMicRecoveryBudget: () => void;

	startWebcamStream: () => Promise<void>;
	stopWebcamStream: () => void;

	startScreenShareStream: (
		selection?: TDesktopScreenShareSelection,
		handlers?: {
			onVideoTrackStarted?: () => void;
			onVideoTrackEnded?: () => void | Promise<void>;
		},
	) => Promise<MediaStreamTrack>;
	stopScreenShareStream: () => void;
	isScreenShareLive: () => boolean;
	requestScreenShareSelection?: () => Promise<TDesktopScreenShareSelection | null>;
};

const getScreenShareStartErrorMessage = (
	error: unknown,
	selection: TDesktopScreenShareSelection | null | undefined,
): string => {
	if (
		selection?.sourceId.startsWith('window:') &&
		error instanceof DOMException &&
		(error.name === 'NotReadableError' || error.name === 'AbortError')
	) {
		return 'This window could not be captured. Protected, elevated, exclusive-fullscreen, or anti-cheat guarded apps may need display sharing or borderless windowed mode instead.';
	}

	return getTrpcError(error, 'Failed to update screen share state');
};

const useVoiceControls = ({
	voiceStateOperations,
	startMicStream,
	hasLiveMicCapture,
	captureMicSession,
	resetMicRecoveryBudget,
	startWebcamStream,
	stopWebcamStream,
	startScreenShareStream,
	stopScreenShareStream,
	isScreenShareLive,
	requestScreenShareSelection,
}: TUseVoiceControlsParams) => {
	const ownVoiceState = useOwnVoiceState();
	const ownUserId = useOwnUserId();
	const currentVoiceChannelId = useCurrentVoiceChannelId();
	const currentVoiceChannelIdRef = useLatestRef(currentVoiceChannelId);
	const pendingShareMutateRef = useRef<Promise<unknown> | undefined>(undefined);
	const isStartingWebcamRef = useRef(false);

	const {
		isStarting: isStartingScreenShare,
		newTransition: newScreenShareTransition,
		beginStart: beginScreenShareStart,
		finishStart: finishScreenShareStart,
		restore: restoreScreenShareStage,
	} = useScreenShareStage({ ownUserId, currentVoiceChannelId });

	const latest = useLatestRef({ startMicStream, hasLiveMicCapture, resetMicRecoveryBudget, captureMicSession });
	const controlsRef = useRef<ReturnType<typeof createOwnMicControls> | undefined>(undefined);
	if (!controlsRef.current)
		controlsRef.current = createOwnMicControls({
			getIntent: () => useServerStore.getState().ownVoiceIntent,
			isMicWanted: () => ownMicWantedSelector(useServerStore.getState()),
			isMicMutedWithoutTest: () => {
				const state = useServerStore.getState();
				return resolveOwnVoiceState({ intent: state.ownVoiceIntent, pushHold: state.ownPushHold, micTestActive: false })
					.micMuted;
			},
			setOwnVoiceIntent,
			cancelPushHold: cancelOwnPushHold,
			commitMicFailure: voiceStateOperations.commitTerminalMicMuted,
			getCurrentVoiceChannelId: () => useServerStore.getState().currentVoiceChannelId,
			hasLiveMicCapture: () => latest.current.hasLiveMicCapture(),
			captureSession: () => latest.current.captureMicSession(),
			startMicStream: () => latest.current.startMicStream(),
			resetMicRecoveryBudget: () => latest.current.resetMicRecoveryBudget(),
			beginOperation: voiceStateOperations.begin,
			isOperationCurrent: voiceStateOperations.isCurrent,
			playSound,
			showError: (message) => toast.error(message),
		});
	const { setMicMuted, toggleMic, toggleSound, ensureMicStarted } = controlsRef.current;

	const toggleWebcam = useCallback(async () => {
		if (isStartingWebcamRef.current) return;

		const latestCurrentVoiceChannelId = currentVoiceChannelIdRef.current;

		if (!latestCurrentVoiceChannelId) return;

		const latestOwnVoiceState = ownVoiceStateSelector(useServerStore.getState());
		const newState = !latestOwnVoiceState.webcamEnabled;
		const operationToken = voiceStateOperations.begin();

		try {
			if (newState) {
				isStartingWebcamRef.current = true;

				try {
					await startWebcamStream();
				} finally {
					isStartingWebcamRef.current = false;
				}

				if (currentVoiceChannelIdRef.current !== latestCurrentVoiceChannelId) {
					stopWebcamStream();
					return;
				}

				updateOwnVoiceState({ webcamEnabled: true });
				playSound(SoundType.OWN_USER_STARTED_WEBCAM);
			} else {
				stopWebcamStream();
				updateOwnVoiceState({ webcamEnabled: false });
				playSound(SoundType.OWN_USER_STOPPED_WEBCAM);
			}

			await sendOwnVoiceStateUpdate({
				webcamEnabled: newState,
			});
		} catch (error) {
			if (error instanceof VoiceSessionExecutionSupersededError) return;
			if (!voiceStateOperations.isCurrent(operationToken)) {
				return;
			}

			if (newState) {
				stopWebcamStream();
				updateOwnVoiceState({ webcamEnabled: false });
			}

			toast.error(getTrpcError(error, 'Failed to update webcam state'));
		}
	}, [startWebcamStream, stopWebcamStream, voiceStateOperations]);

	const toggleScreenShare = useCallback(async () => {
		if (!currentVoiceChannelId) return;
		if (isStartingScreenShare) return;

		const newState = !ownVoiceState.sharingScreen;
		const transition = newScreenShareTransition();
		let selection: TDesktopScreenShareSelection | null | undefined;

		if (newState && requestScreenShareSelection) {
			selection = await requestScreenShareSelection();

			if (!selection) {
				transition.invalidate();
				return;
			}
		}

		try {
			if (newState) {
				beginScreenShareStart();

				await startScreenShareStream(selection || undefined, {
					onVideoTrackStarted: () => {
						if (!transition.isCurrent()) return;
						finishScreenShareStart();
						updateOwnVoiceState({ sharingScreen: true });
						playSound(SoundType.OWN_USER_STARTED_SCREENSHARE);
					},
					onVideoTrackEnded: async () => {
						if (!transition.isCurrent()) {
							return;
						}

						transition.invalidate();
						stopScreenShareStream();
						restoreScreenShareStage();
						updateOwnVoiceState({ sharingScreen: false });

						try {
							await sendOwnVoiceStateUpdate({
								sharingScreen: false,
							});
						} catch {
							// ignore
						}
					},
				});

				if (!transition.isCurrent()) {
					return;
				}

				const startMutate = sendOwnVoiceStateUpdate({
					sharingScreen: true,
				});
				pendingShareMutateRef.current = startMutate;

				try {
					await startMutate;
				} finally {
					if (pendingShareMutateRef.current === startMutate) {
						pendingShareMutateRef.current = undefined;
					}
				}

				return;
			}

			// Invalidate the transition up-front so a late `track.onended` from the
			// producer we're about to stop can't re-run this cleanup path.
			transition.invalidate();
			stopScreenShareStream();
			restoreScreenShareStage();
			updateOwnVoiceState({ sharingScreen: false });
			playSound(SoundType.OWN_USER_STOPPED_SCREENSHARE);

			// Ensure any in-flight start mutation settles before we send the stop,
			// so the server never processes them out of order.
			await pendingShareMutateRef.current?.catch(() => {});

			await sendOwnVoiceStateUpdate({
				sharingScreen: false,
			});
		} catch (error) {
			if (error instanceof VoiceSessionExecutionSupersededError) {
				if (newState) {
					settleSupersededScreenShareStart({
						isCurrent: transition.isCurrent,
						isCaptureLive: isScreenShareLive,
						finishStart: finishScreenShareStart,
						restoreStage: restoreScreenShareStage,
					});
				}
				return;
			}
			if (newState && transition.isCurrent()) {
				transition.invalidate();
				stopScreenShareStream();
				restoreScreenShareStage();
				updateOwnVoiceState({ sharingScreen: false });
			}

			// user cancelled the native screen share picker — not an error
			if (error instanceof DOMException && error.name === 'NotAllowedError') {
				return;
			}

			// transition was superseded (user already stopped) — suppress the toast
			if (newState && !transition.isCurrent()) {
				return;
			}

			toast.error(getScreenShareStartErrorMessage(error, selection));
		}
	}, [
		beginScreenShareStart,
		ownVoiceState.sharingScreen,
		finishScreenShareStart,
		isStartingScreenShare,
		isScreenShareLive,
		newScreenShareTransition,
		restoreScreenShareStage,
		startScreenShareStream,
		stopScreenShareStream,
		currentVoiceChannelId,
		requestScreenShareSelection,
	]);

	return {
		isStartingScreenShare,
		setMicMuted,
		ensureMicStarted,
		toggleMic,
		toggleSound,
		toggleWebcam,
		toggleScreenShare,
	};
};

export { useVoiceControls };
