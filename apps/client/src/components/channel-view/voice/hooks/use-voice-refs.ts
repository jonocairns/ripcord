import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { useIsOwnUser } from '@/features/server/users/hooks';
import { useVoice } from '@/features/server/voice/hooks';
import { StreamKind } from '@sharkord/shared';
import { useEffect, useMemo } from 'react';
import { useAudioLevel } from './use-audio-level';

const useVoiceRefs = (
  remoteId: number,
  pluginId?: string,
  streamKey?: string
) => {
  const {
    remoteUserStreams,
    externalStreams,
    localAudioStream,
    localVideoStream,
    localScreenShareStream,
    ownVoiceState,
    getOrCreateRefs
  } = useVoice();
  const isOwnUser = useIsOwnUser(remoteId);
  const { getVolume, getUserVolumeKey, getExternalVolumeKey } =
    useVolumeControl();

  const {
    videoRef,
    audioRef,
    screenShareRef,
    externalAudioRef,
    externalVideoRef
  } = getOrCreateRefs(remoteId);

  const videoStream = useMemo(() => {
    if (isOwnUser) return localVideoStream;

    return remoteUserStreams[remoteId]?.[StreamKind.VIDEO];
  }, [remoteUserStreams, remoteId, isOwnUser, localVideoStream]);

  const audioStream = useMemo(() => {
    if (isOwnUser) return undefined;

    return remoteUserStreams[remoteId]?.[StreamKind.AUDIO];
  }, [remoteUserStreams, remoteId, isOwnUser]);

  const audioStreamForLevel = useMemo(() => {
    if (isOwnUser) return localAudioStream;

    return remoteUserStreams[remoteId]?.[StreamKind.AUDIO];
  }, [remoteUserStreams, remoteId, isOwnUser, localAudioStream]);

  const screenShareStream = useMemo(() => {
    if (isOwnUser) return localScreenShareStream;

    return remoteUserStreams[remoteId]?.[StreamKind.SCREEN];
  }, [remoteUserStreams, remoteId, isOwnUser, localScreenShareStream]);

  const externalAudioStream = useMemo(() => {
    if (isOwnUser) return undefined;

    const external = externalStreams[remoteId];

    return external?.audioStream;
  }, [externalStreams, remoteId, isOwnUser]);

  const externalVideoStream = useMemo(() => {
    if (isOwnUser) return undefined;

    const external = externalStreams[remoteId];

    return external?.videoStream;
  }, [externalStreams, remoteId, isOwnUser]);

  const { audioLevel, isSpeaking, speakingIntensity } =
    useAudioLevel(audioStreamForLevel);

  const userVolumeKey = getUserVolumeKey(remoteId);
  const userVolume = getVolume(userVolumeKey);

  const externalVolumeKey =
    pluginId && streamKey ? getExternalVolumeKey(pluginId, streamKey) : null;

  const externalVolume = externalVolumeKey ? getVolume(externalVolumeKey) : 100;

  useEffect(() => {
    if (!videoStream || !videoRef.current) return;

    videoRef.current.srcObject = videoStream;
  }, [videoStream, videoRef]);

  useEffect(() => {
    if (!audioStream || !audioRef.current) return;

    audioRef.current.srcObject = audioStream;
  }, [audioStream, audioRef]);

  useEffect(() => {
    if (!screenShareStream || !screenShareRef.current) return;

    screenShareRef.current.srcObject = screenShareStream;
  }, [screenShareStream, screenShareRef]);

  useEffect(() => {
    if (!externalAudioStream || !externalAudioRef.current) return;

    externalAudioRef.current.srcObject = externalAudioStream;
  }, [externalAudioStream, externalAudioRef]);

  useEffect(() => {
    if (!externalVideoStream || !externalVideoRef.current) return;

    externalVideoRef.current.srcObject = externalVideoStream;
  }, [externalVideoStream, externalVideoRef]);

  useEffect(() => {
    if (!audioRef.current) return;

    audioRef.current.volume = userVolume / 100;
  }, [userVolume, audioRef]);

  useEffect(() => {
    if (!externalAudioRef.current) return;

    externalAudioRef.current.volume = externalVolume / 100;
  }, [externalVolume, externalAudioRef]);

  useEffect(() => {
    if (!audioRef.current) return;

    audioRef.current.muted = ownVoiceState.soundMuted;
  }, [ownVoiceState.soundMuted, audioRef]);

  return {
    videoRef,
    audioRef,
    screenShareRef,
    externalAudioRef,
    externalVideoRef,
    hasAudioStream: !!audioStream,
    hasVideoStream: !!videoStream,
    hasScreenShareStream: !!screenShareStream,
    hasExternalAudioStream: !!externalAudioStream,
    hasExternalVideoStream: !!externalVideoStream,
    audioLevel,
    isSpeaking,
    speakingIntensity
  };
};

export { useVoiceRefs };
