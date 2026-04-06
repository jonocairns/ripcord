import type { TVoiceUserState } from '@sharkord/shared';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { updateOwnVoiceState } from '@/features/server/voice/actions';
import { useConfirmedOwnVoiceState, useOwnVoiceState } from '@/features/server/voice/hooks';
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
	const ownVoiceStateRef = useRef(ownVoiceState);
	const currentVoiceChannelIdRef = useRef(currentVoiceChannelId);
	const localAudioStreamRef = useRef(localAudioStream);

	useEffect(() => {
		ownVoiceStateRef.current = ownVoiceState;
	}, [ownVoiceState]);

	useEffect(() => {
		currentVoiceChannelIdRef.current = currentVoiceChannelId;
	}, [currentVoiceChannelId]);

	useEffect(() => {
		localAudioStreamRef.current = localAudioStream;
	}, [localAudioStream]);

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

	const setMicMuted = useCallback(
		async (newState: boolean, options?: TSetMicMutedOptions) => {
			const latestOwnVoiceState = ownVoiceStateRef.current;
			const latestCurrentVoiceChannelId = currentVoiceChannelIdRef.current;
			const latestLocalAudioStream = localAudioStreamRef.current;

			// Push-to-talk / push-to-mute events call this through a ref and can
			// arrive before React re-renders. Read the latest voice state at call
			// time so a quick press+release cannot get stuck on a stale mute value.
			if (newState === latestOwnVoiceState.micMuted) {
				return;
			}

			if (latestOwnVoiceState.soundMuted && !newState) {
				return;
			}

			const shouldPlaySound = options?.playSound ?? true;
			const previousMicMuted = latestOwnVoiceState.micMuted;
			const trpc = getTRPCClient();

			updateOwnVoiceState({ micMuted: newState });

			if (shouldPlaySound) {
				playSound(newState ? SoundType.OWN_USER_MUTED_MIC : SoundType.OWN_USER_UNMUTED_MIC);
			}

			if (!latestCurrentVoiceChannelId) return;

			setLocalAudioTrackEnabled(latestLocalAudioStream, newState);

			try {
				await trpc.voice.updateState.mutate({
					micMuted: newState,
				});

				if (!localAudioStreamRef.current && !newState) {
					await startMicStream();
				}
			} catch (error) {
				updateOwnVoiceState({ micMuted: previousMicMuted });
				setLocalAudioTrackEnabled(localAudioStreamRef.current, previousMicMuted);
				toast.error(getTrpcError(error, 'Failed to update microphone state'));
			}
		},
		[startMicStream],
	);

	const toggleMic = useCallback(async () => {
		const newState = !ownVoiceStateRef.current.micMuted;

		await setMicMuted(newState, { playSound: true });
	}, [setMicMuted]);

	const toggleSound = useCallback(async () => {
		const newState = !ownVoiceState.soundMuted;
		const trpc = getTRPCClient();
		const previousMicMuted = ownVoiceState.micMuted;
		const previousSoundMuted = ownVoiceState.soundMuted;
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
			micMutedBeforeDeafenRef.current = previousSoundMuted ? previousMicMutedBeforeDeafen : undefined;
			updateOwnVoiceState({
				soundMuted: previousSoundMuted,
				micMuted: previousMicMuted,
			} satisfies Partial<TVoiceUserState>);
			setLocalAudioTrackEnabled(localAudioStream, previousMicMuted);
			toast.error(getTrpcError(error, 'Failed to update sound state'));
		}
	}, [ownVoiceState.soundMuted, ownVoiceState.micMuted, currentVoiceChannelId, localAudioStream, startMicStream]);

	const toggleWebcam = useCallback(async () => {
		if (!currentVoiceChannelId) return;

		const newState = !ownVoiceState.webcamEnabled;
		const trpc = getTRPCClient();

		try {
			if (newState) {
				await startWebcamStream();
				updateOwnVoiceState({ webcamEnabled: true });
				playSound(SoundType.OWN_USER_STARTED_WEBCAM);
			} else {
				stopWebcamStream();
				updateOwnVoiceState({ webcamEnabled: false });
				playSound(SoundType.OWN_USER_STOPPED_WEBCAM);
			}

			await trpc.voice.updateState.mutate({
				webcamEnabled: newState,
			});
		} catch (error) {
			if (newState) {
				stopWebcamStream();
				updateOwnVoiceState({ webcamEnabled: false });
			}

			toast.error(getTrpcError(error, 'Failed to update webcam state'));
		}
	}, [ownVoiceState.webcamEnabled, currentVoiceChannelId, startWebcamStream, stopWebcamStream]);

	const toggleScreenShare = useCallback(async () => {
		if (!currentVoiceChannelId) return;

		const newState = !ownVoiceState.sharingScreen;
		const trpc = getTRPCClient();
		let selection: TDesktopScreenShareSelection | null | undefined;

		if (newState && requestScreenShareSelection) {
			selection = await requestScreenShareSelection();

			if (!selection) {
				return;
			}
		}

		try {
			if (newState) {
				const video = await startScreenShareStream(selection || undefined);
				updateOwnVoiceState({ sharingScreen: true });
				playSound(SoundType.OWN_USER_STARTED_SCREENSHARE);

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

			if (!newState) {
				stopScreenShareStream();
				updateOwnVoiceState({ sharingScreen: false });
				playSound(SoundType.OWN_USER_STOPPED_SCREENSHARE);
			}

			await trpc.voice.updateState.mutate({
				sharingScreen: newState,
			});
		} catch (error) {
			if (newState) {
				stopScreenShareStream();
				updateOwnVoiceState({ sharingScreen: false });
			}

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
