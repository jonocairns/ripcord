import type { AppData, Producer } from 'mediasoup-client/types';
import { useCallback, useRef, useState } from 'react';

const useLocalStreams = () => {
	const [localVideoStream, setLocalVideoStream] = useState<MediaStream | undefined>(undefined);
	const [localAudioStream, setLocalAudioStream] = useState<MediaStream | undefined>(undefined);
	const [localScreenShareStream, setLocalScreenShare] = useState<MediaStream | undefined>(undefined);
	const [localScreenShareAudioStream, setLocalScreenShareAudio] = useState<MediaStream | undefined>(undefined);

	const localScreenShareProducer = useRef<Producer<AppData> | undefined>(undefined);

	// keepVideoAndScreen preserves the live webcam + screen-share capture tracks
	// (and their store state) across a teardown so they can be republished onto a
	// freshly created transport. WS-reconnect restore uses this so it does not
	// drop an in-progress screen share. The microphone controller owns local audio
	// capture, publication, and its producer independently of this visual-media
	// cleanup. Every visual producer is closed regardless since its transport is
	// going away.
	const clearLocalStreams = useCallback(
		(opts?: { keepVideoAndScreen?: boolean }) => {
			const keepVideoAndScreen = opts?.keepVideoAndScreen ?? false;

			if (!keepVideoAndScreen) {
				localScreenShareStream?.getVideoTracks().forEach((track) => track.stop());

				setLocalScreenShare(undefined);
			}

			localScreenShareProducer.current?.close();

			localScreenShareProducer.current = undefined;
		},
		[localScreenShareStream],
	);

	return {
		localVideoStream,
		setLocalVideoStream,

		localAudioStream,
		setLocalAudioStream,

		localScreenShareStream,
		setLocalScreenShare,

		localScreenShareAudioStream,
		setLocalScreenShareAudio,

		localScreenShareProducer,

		clearLocalStreams,
	};
};

export { useLocalStreams };
