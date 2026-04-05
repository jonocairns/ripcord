import type { TVoiceUserState } from '@sharkord/shared';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { updateOwnVoiceState } from '@/features/server/voice/actions';
import { getConfirmedOwnVoiceState, useConfirmedOwnVoiceState, useOwnVoiceState } from '@/features/server/voice/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import type { TDesktopScreenShareSelection } from '@/runtime/types';

type TUseVoiceControlsParams = {
	startMicStream: () => Promise<void>;
	localAudioStream: MediaStream | undefined;

	startWebcamStream: () => Promise<void>;
	stopWebcamStream: () => void;

	startScreenShareStream: (selection?: TDesktopScreenShareSelection) => Promise<MediaStreamTrack>;
	stopScreenShareStream: () => void;
	requestScreenShareSelection?: () => Promise<TDesktopScreenShareSelection | null>;
};

type TSetMicMutedOptions = {
	playSound?: boolean;
};

const setLocalAudioTrackEnabled = (stream: MediaStream | undefined, micMuted: boolean) => {
	stream?.getAudioTracks().forEach((track) => {
		track.enabled = !micMuted;
	});
};

const useVoiceControls = ({
	startMicStream,
	localAudioStream,
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
	const currentVoiceChannelId = useCurrentVoiceChannelId();
	const micMutedBeforeDeafenRef = useRef<boolean | undefined>(undefined);

	useEffect(() => {
		if (currentVoiceChannelId === undefined || !ownVoiceState.soundMuted) {
			micMutedBeforeDeafenRef.current = undefined;
		}
	}, [currentVoiceChannelId, ownVoiceState.soundMuted]);

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

	const setMicMuted = useCallback(
		async (newState: boolean, options?: TSetMicMutedOptions) => {
			if (newState === ownVoiceState.micMuted) {
				return;
			}

			if (ownVoiceState.soundMuted && !newState) {
				return;
			}

			const shouldPlaySound = options?.playSound ?? true;
			const trpc = getTRPCClient();

			updateOwnVoiceState({ micMuted: newState });

			if (shouldPlaySound) {
				playSound(newState ? SoundType.OWN_USER_MUTED_MIC : SoundType.OWN_USER_UNMUTED_MIC);
			}

			if (!currentVoiceChannelId) return;

			setLocalAudioTrackEnabled(localAudioStream, newState);

			try {
				await trpc.voice.updateState.mutate({
					micMuted: newState,
				});

				if (!localAudioStream && !newState) {
					await startMicStream();
				}
			} catch (error) {
				const confirmedVoiceState = getConfirmedOwnVoiceState();
				const revertedMicMuted = confirmedVoiceState?.micMuted ?? !newState;

				updateOwnVoiceState(confirmedVoiceState ?? { micMuted: revertedMicMuted });
				setLocalAudioTrackEnabled(localAudioStream, revertedMicMuted);
				toast.error(getTrpcError(error, 'Failed to update microphone state'));
			}
		},
		[ownVoiceState.micMuted, ownVoiceState.soundMuted, currentVoiceChannelId, localAudioStream, startMicStream],
	);

	const toggleMic = useCallback(async () => {
		const newState = !ownVoiceState.micMuted;

		await setMicMuted(newState, { playSound: true });
	}, [ownVoiceState.micMuted, setMicMuted]);

	const toggleSound = useCallback(async () => {
		const newState = !ownVoiceState.soundMuted;
		const trpc = getTRPCClient();
		const previousMicMuted = ownVoiceState.micMuted;
		const previousMicMutedBeforeDeafen = micMutedBeforeDeafenRef.current;
		let nextMicMuted = previousMicMuted;

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

		setLocalAudioTrackEnabled(localAudioStream, nextMicMuted);

		playSound(newState ? SoundType.OWN_USER_MUTED_SOUND : SoundType.OWN_USER_UNMUTED_SOUND);

		if (!currentVoiceChannelId) return;

		try {
			await trpc.voice.updateState.mutate({
				soundMuted: newState,
				micMuted: nextMicMuted,
			});

			if (!localAudioStream && !nextMicMuted) {
				await startMicStream();
			}
		} catch (error) {
			const confirmedVoiceState = getConfirmedOwnVoiceState();
			const revertedSoundMuted = confirmedVoiceState?.soundMuted ?? ownVoiceState.soundMuted;
			const revertedMicMuted = confirmedVoiceState?.micMuted ?? previousMicMuted;

			micMutedBeforeDeafenRef.current = revertedSoundMuted ? previousMicMutedBeforeDeafen : undefined;
			updateOwnVoiceState(
				confirmedVoiceState ??
					({
						soundMuted: revertedSoundMuted,
						micMuted: revertedMicMuted,
					} satisfies Partial<TVoiceUserState>),
			);
			setLocalAudioTrackEnabled(localAudioStream, revertedMicMuted);
			toast.error(getTrpcError(error, 'Failed to update sound state'));
		}
	}, [ownVoiceState.soundMuted, ownVoiceState.micMuted, currentVoiceChannelId, localAudioStream, startMicStream]);

	const toggleWebcam = useCallback(async () => {
		if (!currentVoiceChannelId) return;

		const newState = !ownVoiceState.webcamEnabled;
		const previousWebcamEnabled = ownVoiceState.webcamEnabled;
		const trpc = getTRPCClient();

		updateOwnVoiceState({ webcamEnabled: newState });

		playSound(newState ? SoundType.OWN_USER_STARTED_WEBCAM : SoundType.OWN_USER_STOPPED_WEBCAM);

		try {
			if (newState) {
				await startWebcamStream();
			}

			await trpc.voice.updateState.mutate({
				webcamEnabled: newState,
			});

			if (!newState) {
				stopWebcamStream();
			}
		} catch (error) {
			if (newState) {
				stopWebcamStream();
			}

			updateOwnVoiceState({ webcamEnabled: previousWebcamEnabled });

			toast.error(getTrpcError(error, 'Failed to update webcam state'));
		}
	}, [ownVoiceState.webcamEnabled, currentVoiceChannelId, startWebcamStream, stopWebcamStream]);

	const toggleScreenShare = useCallback(async () => {
		if (!currentVoiceChannelId) return;

		const newState = !ownVoiceState.sharingScreen;
		const previousSharingScreen = ownVoiceState.sharingScreen;
		const trpc = getTRPCClient();
		let selection: TDesktopScreenShareSelection | null | undefined;

		if (newState && requestScreenShareSelection) {
			selection = await requestScreenShareSelection();

			if (!selection) {
				return;
			}
		}

		updateOwnVoiceState({ sharingScreen: newState });

		playSound(newState ? SoundType.OWN_USER_STARTED_SCREENSHARE : SoundType.OWN_USER_STOPPED_SCREENSHARE);

		try {
			if (newState) {
				const video = await startScreenShareStream(selection || undefined);

				// handle native screen share end
				video.onended = async () => {
					stopScreenShareStream();
					updateOwnVoiceState({ sharingScreen: false });

					try {
						await trpc.voice.updateState.mutate({
							sharingScreen: false,
						});
					} catch {
						// ignore
					}
				};
			}

			await trpc.voice.updateState.mutate({
				sharingScreen: newState,
			});

			if (!newState) {
				stopScreenShareStream();
			}
		} catch (error) {
			if (newState) {
				stopScreenShareStream();
			}

			updateOwnVoiceState({ sharingScreen: previousSharingScreen });

			// user cancelled the native screen share picker — not an error
			if (error instanceof DOMException && error.name === 'NotAllowedError') {
				return;
			}

			toast.error(getTrpcError(error, 'Failed to update screen share state'));
		}
	}, [
		ownVoiceState.sharingScreen,
		startScreenShareStream,
		stopScreenShareStream,
		currentVoiceChannelId,
		requestScreenShareSelection,
	]);

	return {
		setMicMuted,
		toggleMic,
		toggleSound,
		toggleWebcam,
		toggleScreenShare,
	};
};

export { useVoiceControls };
