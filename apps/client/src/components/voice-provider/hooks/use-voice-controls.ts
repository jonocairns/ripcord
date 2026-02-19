import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { updateOwnVoiceState } from '@/features/server/voice/actions';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import type { TDesktopScreenShareSelection } from '@/runtime/types';
import { useCallback } from 'react';
import { toast } from 'sonner';

type TUseVoiceControlsParams = {
  startMicStream: () => Promise<void>;
  localAudioStream: MediaStream | undefined;

  startWebcamStream: () => Promise<void>;
  stopWebcamStream: () => void;

  startScreenShareStream: (
    selection?: TDesktopScreenShareSelection
  ) => Promise<MediaStreamTrack>;
  stopScreenShareStream: () => void;
  requestScreenShareSelection?: () => Promise<TDesktopScreenShareSelection | null>;
};

type TSetMicMutedOptions = {
  playSound?: boolean;
};

const useVoiceControls = ({
  startMicStream,
  localAudioStream,
  startWebcamStream,
  stopWebcamStream,
  startScreenShareStream,
  stopScreenShareStream,
  requestScreenShareSelection
}: TUseVoiceControlsParams) => {
  const ownVoiceState = useOwnVoiceState();
  const currentVoiceChannelId = useCurrentVoiceChannelId();

  const setMicMuted = useCallback(
    async (newState: boolean, options?: TSetMicMutedOptions) => {
      if (newState === ownVoiceState.micMuted) {
        return;
      }

      const shouldPlaySound = options?.playSound ?? true;
      const trpc = getTRPCClient();

      updateOwnVoiceState({ micMuted: newState });

      if (shouldPlaySound) {
        playSound(
          newState
            ? SoundType.OWN_USER_MUTED_MIC
            : SoundType.OWN_USER_UNMUTED_MIC
        );
      }

      if (!currentVoiceChannelId) return;

      localAudioStream?.getAudioTracks().forEach((track) => {
        track.enabled = !newState;
      });

      try {
        await trpc.voice.updateState.mutate({
          micMuted: newState
        });

        if (!localAudioStream && !newState) {
          await startMicStream();
        }
      } catch (error) {
        updateOwnVoiceState({ micMuted: !newState });
        toast.error(getTrpcError(error, 'Failed to update microphone state'));
      }
    },
    [
      ownVoiceState.micMuted,
      currentVoiceChannelId,
      localAudioStream,
      startMicStream
    ]
  );

  const toggleMic = useCallback(async () => {
    const newState = !ownVoiceState.micMuted;

    await setMicMuted(newState, { playSound: true });
  }, [ownVoiceState.micMuted, setMicMuted]);

  const toggleSound = useCallback(async () => {
    const newState = !ownVoiceState.soundMuted;
    const trpc = getTRPCClient();

    updateOwnVoiceState({ soundMuted: newState });
    playSound(
      newState
        ? SoundType.OWN_USER_MUTED_SOUND
        : SoundType.OWN_USER_UNMUTED_SOUND
    );

    if (!currentVoiceChannelId) return;

    try {
      await trpc.voice.updateState.mutate({
        soundMuted: newState
      });
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to update sound state'));
    }
  }, [ownVoiceState.soundMuted, currentVoiceChannelId]);

  const toggleWebcam = useCallback(async () => {
    if (!currentVoiceChannelId) return;

    const newState = !ownVoiceState.webcamEnabled;
    const trpc = getTRPCClient();

    updateOwnVoiceState({ webcamEnabled: newState });

    playSound(
      newState
        ? SoundType.OWN_USER_STARTED_WEBCAM
        : SoundType.OWN_USER_STOPPED_WEBCAM
    );

    try {
      if (newState) {
        await startWebcamStream();
      } else {
        stopWebcamStream();
      }

      await trpc.voice.updateState.mutate({
        webcamEnabled: newState
      });
    } catch (error) {
      updateOwnVoiceState({ webcamEnabled: false });

      try {
        await trpc.voice.updateState.mutate({ webcamEnabled: false });
      } catch {
        // ignore
      }

      toast.error(getTrpcError(error, 'Failed to update webcam state'));
    }
  }, [
    ownVoiceState.webcamEnabled,
    currentVoiceChannelId,
    startWebcamStream,
    stopWebcamStream
  ]);

  const toggleScreenShare = useCallback(async () => {
    if (!currentVoiceChannelId) return;

    const newState = !ownVoiceState.sharingScreen;
    const trpc = getTRPCClient();
    let selection: TDesktopScreenShareSelection | null | undefined = undefined;

    if (newState && requestScreenShareSelection) {
      selection = await requestScreenShareSelection();

      if (!selection) {
        return;
      }
    }

    updateOwnVoiceState({ sharingScreen: newState });

    playSound(
      newState
        ? SoundType.OWN_USER_STARTED_SCREENSHARE
        : SoundType.OWN_USER_STOPPED_SCREENSHARE
    );

    try {
      if (newState) {
        const video = await startScreenShareStream(selection || undefined);

        // handle native screen share end
        video.onended = async () => {
          stopScreenShareStream();
          updateOwnVoiceState({ sharingScreen: false });

          try {
            await trpc.voice.updateState.mutate({
              sharingScreen: false
            });
          } catch {
            // ignore
          }
        };
      } else {
        stopScreenShareStream();
      }

      await trpc.voice.updateState.mutate({
        sharingScreen: newState
      });
    } catch (error) {
      updateOwnVoiceState({ sharingScreen: false });

      try {
        await trpc.voice.updateState.mutate({ sharingScreen: false });
      } catch {
        // ignore
      }

      toast.error(getTrpcError(error, 'Failed to update screen share state'));
    }
  }, [
    ownVoiceState.sharingScreen,
    startScreenShareStream,
    stopScreenShareStream,
    currentVoiceChannelId,
    requestScreenShareSelection
  ]);

  return {
    setMicMuted,
    toggleMic,
    toggleSound,
    toggleWebcam,
    toggleScreenShare
  };
};

export { useVoiceControls };
