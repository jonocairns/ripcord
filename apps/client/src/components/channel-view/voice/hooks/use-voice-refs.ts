import { useIsOwnUser } from '@/features/server/users/hooks';
import { useVoice } from '@/features/server/voice/hooks';
import { StreamKind } from '@sharkord/shared';
import { useEffect, useMemo, useRef } from 'react';
import { useAudioLevel } from './use-audio-level';

const useVoiceRefs = (userId: number) => {
  const { remoteStreams, localVideoStream, localScreenShareStream } =
    useVoice();
  const isOwnUser = useIsOwnUser(userId);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const screenShareRef = useRef<HTMLVideoElement>(null);

  const videoStream = useMemo(() => {
    if (isOwnUser) return localVideoStream;

    return remoteStreams[userId]?.[StreamKind.VIDEO];
  }, [remoteStreams, userId, isOwnUser, localVideoStream]);

  const audioStream = useMemo(() => {
    return remoteStreams[userId]?.[StreamKind.AUDIO];
  }, [remoteStreams, userId]);

  const screenShareStream = useMemo(() => {
    if (isOwnUser) return localScreenShareStream;

    return remoteStreams[userId]?.[StreamKind.SCREEN];
  }, [remoteStreams, userId, isOwnUser, localScreenShareStream]);

  // Audio level detection
  const { audioLevel, isSpeaking, speakingIntensity } = useAudioLevel(audioStream);

  useEffect(() => {
    if (!videoStream || !videoRef.current) return;

    videoRef.current.srcObject = videoStream;
  }, [videoStream]);

  useEffect(() => {
    if (!audioStream || !audioRef.current) return;

    audioRef.current.srcObject = audioStream;
  }, [audioStream]);

  useEffect(() => {
    if (!screenShareStream || !screenShareRef.current) return;

    screenShareRef.current.srcObject = screenShareStream;
  }, [screenShareStream]);

  return {
    videoRef,
    audioRef,
    screenShareRef,
    hasAudioStream: !!audioStream,
    hasVideoStream: !!videoStream,
    hasScreenShareStream: !!screenShareStream,
    audioLevel,
    isSpeaking,
    speakingIntensity
  };
};

export { useVoiceRefs };
