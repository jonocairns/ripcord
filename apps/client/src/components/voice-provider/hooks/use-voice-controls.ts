import type { TVoiceUserState } from '@sharkord/shared';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useServerStore } from '@/features/server/slice';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { sendOwnVoiceStateUpdate, updateOwnVoiceState } from '@/features/server/voice/actions';
import { useConfirmedOwnVoiceState, useOwnVoiceState } from '@/features/server/voice/hooks';
import { ownVoiceStateSelector } from '@/features/server/voice/selectors';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useLatestRef } from '@/hooks/use-latest-ref';
import type { TDesktopScreenShareSelection } from '@/runtime/types';
import { shouldApplyVoiceStateOperationResult, startVoiceStateOperation } from '../voice-state-operation';
import { useScreenShareStage } from './use-screen-share-stage';

type TUseVoiceControlsParams = {
	startMicStream: () => Promise<void>;
	localAudioStream: MediaStream | undefined;
	setMicProcessingMuted: (micMuted: boolean) => void;

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
	requestScreenShareSelection?: () => Promise<TDesktopScreenShareSelection | null>;
};

type TSetMicMutedOptions = {
	playSound?: boolean;
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

const setLocalAudioTrackEnabled = (stream: MediaStream | undefined, micMuted: boolean) => {
	stream?.getAudioTracks().forEach((track) => {
		track.enabled = !micMuted;
	});
};

const useVoiceControls = ({
	startMicStream,
	localAudioStream,
	setMicProcessingMuted,
	startWebcamStream,
	stopWebcamStream,
	startScreenShareStream,
	stopScreenShareStream,
	requestScreenShareSelection,
}: TUseVoiceControlsParams) => {
	const ownVoiceState = useOwnVoiceState();
	const ownConfirmedVoiceState = useConfirmedOwnVoiceState();
	const confirmedSoundMuted = ownConfirmedVoiceState?.soundMuted;
	const confirmedMicMuted = ownConfirmedVoiceState?.micMuted;
	const ownUserId = useOwnUserId();
	const currentVoiceChannelId = useCurrentVoiceChannelId();
	const micMutedBeforeDeafenRef = useRef<boolean | undefined>(undefined);
	const currentVoiceChannelIdRef = useLatestRef(currentVoiceChannelId);
	const localAudioStreamRef = useLatestRef(localAudioStream);
	const voiceStateOperationSequenceRef = useRef(0);
	const pendingShareMutateRef = useRef<Promise<unknown> | undefined>(undefined);
	const isStartingWebcamRef = useRef(false);

	const {
		isStarting: isStartingScreenShare,
		newTransition: newScreenShareTransition,
		beginStart: beginScreenShareStart,
		finishStart: finishScreenShareStart,
		restore: restoreScreenShareStage,
	} = useScreenShareStage({ ownUserId, currentVoiceChannelId });

	useEffect(() => {
		// Preserve the pre-deafen mic state across reconnects and voice rejoin.
		// currentVoiceChannelId is cleared during disconnect / auto-rejoin, and
		// dropping this ref there would make undeafen restore to "still muted".
		if (!ownVoiceState.soundMuted) {
			micMutedBeforeDeafenRef.current = undefined;
		}
	}, [ownVoiceState.soundMuted]);

	useEffect(() => {
		if (micMutedBeforeDeafenRef.current === undefined || ownVoiceState.soundMuted !== true) {
			return;
		}

		if (confirmedSoundMuted === undefined || confirmedMicMuted === undefined) {
			return;
		}

		if (confirmedSoundMuted !== true || confirmedMicMuted !== true) {
			micMutedBeforeDeafenRef.current = confirmedMicMuted;
		}
	}, [confirmedSoundMuted, confirmedMicMuted, ownVoiceState.soundMuted]);

	const applyMicMuted = useCallback(
		(stream: MediaStream | undefined, micMuted: boolean) => {
			setLocalAudioTrackEnabled(stream, micMuted);
			setMicProcessingMuted(micMuted);
		},
		[setMicProcessingMuted],
	);

	const setMicMuted = useCallback(
		async (newState: boolean, options?: TSetMicMutedOptions) => {
			// Read mic state directly from the store — updateOwnVoiceState writes
			// synchronously, but ownVoiceStateRef only updates after React re-renders.
			// Reading the ref risks a stale guard on rapid press+release cycles.
			const latestOwnVoiceState = ownVoiceStateSelector(useServerStore.getState());
			const latestCurrentVoiceChannelId = currentVoiceChannelIdRef.current;
			const latestLocalAudioStream = localAudioStreamRef.current;

			if (newState === latestOwnVoiceState.micMuted) {
				return;
			}

			if (latestOwnVoiceState.soundMuted && !newState) {
				return;
			}

			const shouldPlaySound = options?.playSound ?? true;
			const previousMicMuted = latestOwnVoiceState.micMuted;
			const voiceStateOperation = startVoiceStateOperation(voiceStateOperationSequenceRef.current);
			voiceStateOperationSequenceRef.current = voiceStateOperation.latestOperationToken;
			const { operationToken } = voiceStateOperation;

			updateOwnVoiceState({ micMuted: newState });

			if (shouldPlaySound) {
				playSound(newState ? SoundType.OWN_USER_MUTED_MIC : SoundType.OWN_USER_UNMUTED_MIC);
			}

			if (!latestCurrentVoiceChannelId) return;

			applyMicMuted(latestLocalAudioStream, newState);

			try {
				await sendOwnVoiceStateUpdate({
					micMuted: newState,
				});

				if (
					shouldApplyVoiceStateOperationResult(operationToken, voiceStateOperationSequenceRef.current) &&
					!localAudioStreamRef.current &&
					!newState
				) {
					await startMicStream();
				}
			} catch (error) {
				if (!shouldApplyVoiceStateOperationResult(operationToken, voiceStateOperationSequenceRef.current)) {
					return;
				}

				updateOwnVoiceState({ micMuted: previousMicMuted });
				applyMicMuted(localAudioStreamRef.current, previousMicMuted);
				toast.error(getTrpcError(error, 'Failed to update microphone state'));
			}
		},
		[applyMicMuted, startMicStream],
	);

	const toggleMic = useCallback(async () => {
		const newState = !ownVoiceStateSelector(useServerStore.getState()).micMuted;

		await setMicMuted(newState, { playSound: true });
	}, [setMicMuted]);

	const toggleSound = useCallback(async () => {
		// Read state directly from the store to avoid stale closure values,
		// matching the approach used by setMicMuted above.
		const latestOwnVoiceState = ownVoiceStateSelector(useServerStore.getState());
		const latestCurrentVoiceChannelId = currentVoiceChannelIdRef.current;
		const latestLocalAudioStream = localAudioStreamRef.current;

		const newState = !latestOwnVoiceState.soundMuted;
		const previousMicMuted = latestOwnVoiceState.micMuted;
		const previousSoundMuted = latestOwnVoiceState.soundMuted;
		const previousMicMutedBeforeDeafen = micMutedBeforeDeafenRef.current;
		let nextMicMuted = previousMicMuted;
		const voiceStateOperation = startVoiceStateOperation(voiceStateOperationSequenceRef.current);
		voiceStateOperationSequenceRef.current = voiceStateOperation.latestOperationToken;
		const { operationToken } = voiceStateOperation;

		if (newState) {
			micMutedBeforeDeafenRef.current = previousMicMuted;
			nextMicMuted = true;
		} else if (micMutedBeforeDeafenRef.current !== undefined) {
			nextMicMuted = micMutedBeforeDeafenRef.current;
			micMutedBeforeDeafenRef.current = undefined;
		}

		updateOwnVoiceState({
			soundMuted: newState,
			micMuted: nextMicMuted,
		});

		applyMicMuted(latestLocalAudioStream, nextMicMuted);

		playSound(newState ? SoundType.OWN_USER_MUTED_SOUND : SoundType.OWN_USER_UNMUTED_SOUND);

		if (!latestCurrentVoiceChannelId) return;

		try {
			await sendOwnVoiceStateUpdate({
				soundMuted: newState,
				micMuted: nextMicMuted,
			});

			if (
				shouldApplyVoiceStateOperationResult(operationToken, voiceStateOperationSequenceRef.current) &&
				!localAudioStreamRef.current &&
				!nextMicMuted
			) {
				await startMicStream();
			}
		} catch (error) {
			if (!shouldApplyVoiceStateOperationResult(operationToken, voiceStateOperationSequenceRef.current)) {
				return;
			}

			micMutedBeforeDeafenRef.current = previousSoundMuted ? previousMicMutedBeforeDeafen : undefined;
			updateOwnVoiceState({
				soundMuted: previousSoundMuted,
				micMuted: previousMicMuted,
			} satisfies Partial<TVoiceUserState>);
			applyMicMuted(localAudioStreamRef.current, previousMicMuted);
			toast.error(getTrpcError(error, 'Failed to update sound state'));
		}
	}, [applyMicMuted, startMicStream]);

	const toggleWebcam = useCallback(async () => {
		if (isStartingWebcamRef.current) return;

		const latestCurrentVoiceChannelId = currentVoiceChannelIdRef.current;

		if (!latestCurrentVoiceChannelId) return;

		const latestOwnVoiceState = ownVoiceStateSelector(useServerStore.getState());
		const newState = !latestOwnVoiceState.webcamEnabled;
		const voiceStateOperation = startVoiceStateOperation(voiceStateOperationSequenceRef.current);
		voiceStateOperationSequenceRef.current = voiceStateOperation.latestOperationToken;
		const { operationToken } = voiceStateOperation;

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
			if (!shouldApplyVoiceStateOperationResult(operationToken, voiceStateOperationSequenceRef.current)) {
				return;
			}

			if (newState) {
				stopWebcamStream();
				updateOwnVoiceState({ webcamEnabled: false });
			}

			toast.error(getTrpcError(error, 'Failed to update webcam state'));
		}
	}, [startWebcamStream, stopWebcamStream]);

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
		toggleMic,
		toggleSound,
		toggleWebcam,
		toggleScreenShare,
	};
};

export { useVoiceControls };
