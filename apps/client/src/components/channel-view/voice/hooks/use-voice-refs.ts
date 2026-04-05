import { StreamKind } from '@sharkord/shared';
import { useEffect, useMemo } from 'react';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { MASTER_OUTPUT_VOLUME_KEY } from '@/components/voice-provider/volume-control-storage';
import { useIsOwnUser } from '@/features/server/users/hooks';
import { useVoice } from '@/features/server/voice/hooks';

type UseVoiceRefsOptions = {
	remoteId: number;
	pluginId?: string;
	streamKey?: string;
	attachScreenShareAudio?: boolean;
	attachExternalAudio?: boolean;
};

const useVoiceRefs = ({
	remoteId,
	pluginId,
	streamKey,
	attachScreenShareAudio = true,
	attachExternalAudio = true,
}: UseVoiceRefsOptions) => {
	const {
		remoteUserStreams,
		externalStreams,
		localVideoStream,
		localScreenShareStream,
		ownVoiceState,
		getOrCreateRefs,
	} = useVoice();
	const isOwnUser = useIsOwnUser(remoteId);
	const { getVolume, getUserVolumeKey, getUserScreenVolumeKey, getExternalVolumeKey } = useVolumeControl();

	const { videoRef, audioRef, screenShareRef, screenShareAudioRef, externalAudioRef, externalVideoRef } =
		getOrCreateRefs(remoteId);

	const videoStream = useMemo(() => {
		if (isOwnUser) return localVideoStream;

		return remoteUserStreams[remoteId]?.[StreamKind.VIDEO];
	}, [remoteUserStreams, remoteId, isOwnUser, localVideoStream]);

	const audioStream = useMemo(() => {
		if (isOwnUser) return undefined;

		return remoteUserStreams[remoteId]?.[StreamKind.AUDIO];
	}, [remoteUserStreams, remoteId, isOwnUser]);

	const screenShareStream = useMemo(() => {
		if (isOwnUser) return localScreenShareStream;

		return remoteUserStreams[remoteId]?.[StreamKind.SCREEN];
	}, [remoteUserStreams, remoteId, isOwnUser, localScreenShareStream]);

	const screenShareAudioStream = useMemo(() => {
		if (isOwnUser) return undefined;

		return remoteUserStreams[remoteId]?.[StreamKind.SCREEN_AUDIO];
	}, [remoteUserStreams, remoteId, isOwnUser]);

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

	const userVolumeKey = getUserVolumeKey(remoteId);
	const userVolume = getVolume(userVolumeKey);
	const masterOutputVolume = getVolume(MASTER_OUTPUT_VOLUME_KEY);

	const userScreenVolumeKey = getUserScreenVolumeKey(remoteId);
	const userScreenVolume = getVolume(userScreenVolumeKey);

	const externalVolumeKey = pluginId && streamKey ? getExternalVolumeKey(pluginId, streamKey) : null;

	const externalVolume = externalVolumeKey ? getVolume(externalVolumeKey) : 100;
	const userPlaybackVolume = (userVolume * masterOutputVolume) / 10000;
	const screenSharePlaybackVolume = (userScreenVolume * masterOutputVolume) / 10000;
	const externalPlaybackVolume = (externalVolume * masterOutputVolume) / 10000;

	useEffect(() => {
		if (!videoStream || !videoRef.current) return;

		videoRef.current.srcObject = videoStream;
	}, [videoStream, videoRef]);

	useEffect(() => {
		if (!audioStream || !audioRef.current) return;

		if (audioRef.current.srcObject !== audioStream) {
			audioRef.current.srcObject = audioStream;
		}

		audioRef.current.volume = userPlaybackVolume;
	}, [audioStream, audioRef, userPlaybackVolume]);

	useEffect(() => {
		if (!screenShareStream || !screenShareRef.current) return;

		if (screenShareRef.current.srcObject !== screenShareStream) {
			screenShareRef.current.srcObject = screenShareStream;
		}
	}, [screenShareStream, screenShareRef]);

	useEffect(() => {
		if (!screenShareAudioRef.current) {
			return;
		}

		if (!attachScreenShareAudio || !screenShareAudioStream) {
			if (screenShareAudioRef.current.srcObject) {
				screenShareAudioRef.current.srcObject = null;
			}
			return;
		}

		if (screenShareAudioRef.current.srcObject !== screenShareAudioStream) {
			screenShareAudioRef.current.srcObject = screenShareAudioStream;
		}

		screenShareAudioRef.current.volume = screenSharePlaybackVolume;
	}, [attachScreenShareAudio, screenShareAudioStream, screenShareAudioRef, screenSharePlaybackVolume]);

	useEffect(() => {
		if (!externalAudioRef.current) {
			return;
		}

		if (!attachExternalAudio || !externalAudioStream) {
			if (externalAudioRef.current.srcObject) {
				externalAudioRef.current.srcObject = null;
			}
			return;
		}

		if (externalAudioRef.current.srcObject !== externalAudioStream) {
			externalAudioRef.current.srcObject = externalAudioStream;
		}

		externalAudioRef.current.volume = externalPlaybackVolume;
	}, [attachExternalAudio, externalAudioStream, externalAudioRef, externalPlaybackVolume]);

	useEffect(() => {
		if (!externalVideoStream || !externalVideoRef.current) return;

		if (externalVideoRef.current.srcObject !== externalVideoStream) {
			externalVideoRef.current.srcObject = externalVideoStream;
		}
	}, [externalVideoStream, externalVideoRef]);

	useEffect(() => {
		if (!audioRef.current) return;

		audioRef.current.muted = ownVoiceState.soundMuted;
	}, [ownVoiceState.soundMuted, audioRef]);

	return {
		videoRef,
		audioRef,
		screenShareRef,
		screenShareAudioRef,
		externalAudioRef,
		externalVideoRef,
		hasAudioStream: !!audioStream,
		hasVideoStream: !!videoStream,
		hasScreenShareStream: !!screenShareStream,
		hasScreenShareAudioStream: !!screenShareAudioStream,
		hasExternalAudioStream: !!externalAudioStream,
		hasExternalVideoStream: !!externalVideoStream,
		externalAudioStream,
		externalVideoStream,
		screenShareStream,
		screenShareAudioStream,
	};
};

export { useVoiceRefs };
