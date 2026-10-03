import { useState } from 'react';

const useLocalStreams = () => {
	const [localVideoStream, setLocalVideoStream] = useState<MediaStream | undefined>(undefined);
	const [localAudioStream, setLocalAudioStream] = useState<MediaStream | undefined>(undefined);
	const [localScreenShareStream, setLocalScreenShare] = useState<MediaStream | undefined>(undefined);
	const [localScreenShareAudioStream, setLocalScreenShareAudio] = useState<MediaStream | undefined>(undefined);

	return {
		localVideoStream,
		setLocalVideoStream,

		localAudioStream,
		setLocalAudioStream,

		localScreenShareStream,
		setLocalScreenShare,

		localScreenShareAudioStream,
		setLocalScreenShareAudio,
	};
};

export { useLocalStreams };
