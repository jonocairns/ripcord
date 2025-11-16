import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { updateOwnVoiceState } from '@/features/server/voice/actions';
import { useOwnVoiceState } from '@/features/server/voice/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { useCallback } from 'react';
import { toast } from 'sonner';

type TUseVoiceControlsParams = {
  startMicStream: () => Promise<void>;
  localAudioStream: MediaStream | undefined;

  startWebcamStream: () => Promise<void>;
  stopWebcamStream: () => void;

  startScreenShareStream: () => Promise<MediaStreamTrack>;
  stopScreenShareStream: () => void;
};

const useVoiceControls = ({
  startMicStream,
  localAudioStream,
  startWebcamStream,
  stopWebcamStream,
  startScreenShareStream,
  stopScreenShareStream
}: TUseVoiceControlsParams) => {
  const ownVoiceState = useOwnVoiceState();
  const currentVoiceChannelId = useCurrentVoiceChannelId();

  const toggleMic = useCallback(async () => {
    const newState = !ownVoiceState.micMuted;
    const trpc = getTRPCClient();

    updateOwnVoiceState({ micMuted: newState });

    if (!currentVoiceChannelId) return;

    localAudioStream?.getAudioTracks().forEach((track) => {
      track.enabled = !newState;
    });

    try {
      await trpc.voice.updateState.mutate({
        micMuted: newState
      });

      if (!localAudioStream) {
        await startMicStream();
      }
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to update microphone state'));
    }
  }, [
    ownVoiceState.micMuted,
    startMicStream,
    currentVoiceChannelId,
    localAudioStream
  ]);

  const toggleSound = useCallback(async () => {
    const newState = !ownVoiceState.soundMuted;
    const trpc = getTRPCClient();

    updateOwnVoiceState({ soundMuted: newState });

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

    try {
      await trpc.voice.updateState.mutate({
        webcamEnabled: newState
      });

      if (newState) {
        await startWebcamStream();
      } else {
        stopWebcamStream();
      }
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to update webcam state'));
    }
  }, [
    ownVoiceState.webcamEnabled,
    currentVoiceChannelId,
    startWebcamStream,
    stopWebcamStream
  ]);

  const toggleScreenShare = useCallback(async () => {
    const newState = !ownVoiceState.sharingScreen;
    const trpc = getTRPCClient();

    updateOwnVoiceState({ sharingScreen: newState });

    try {
      await trpc.voice.updateState.mutate({
        sharingScreen: newState
      });

      if (newState) {
        const video = await startScreenShareStream();

        // handle native screen share end
        video.onended = async () => {
          stopScreenShareStream();
          updateOwnVoiceState({ sharingScreen: false });

          await trpc.voice.updateState.mutate({
            sharingScreen: false
          });
        };
      } else {
        stopScreenShareStream();
      }
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to update screen share state'));
    }
  }, [
    ownVoiceState.sharingScreen,
    startScreenShareStream,
    stopScreenShareStream
  ]);

  return {
    toggleMic,
    toggleSound,
    toggleWebcam,
    toggleScreenShare,
    ownVoiceState
  };
};

export { useVoiceControls };
