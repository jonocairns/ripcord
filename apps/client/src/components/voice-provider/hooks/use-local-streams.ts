import type { AppData, Producer } from 'mediasoup-client/types';
import { useCallback, useRef, useState } from 'react';

const useLocalStreams = () => {
	const [localVideoStream, setLocalVideoStream] = useState<MediaStream | undefined>(undefined);
	const [localAudioStream, setLocalAudioStream] = useState<MediaStream | undefined>(undefined);
	const [localScreenShareStream, setLocalScreenShare] = useState<MediaStream | undefined>(undefined);
	const [localScreenShareAudioStream, setLocalScreenShareAudio] = useState<MediaStream | undefined>(undefined);

	const localVideoProducer = useRef<Producer<AppData> | undefined>(undefined);
	const localAudioProducer = useRef<Producer<AppData> | undefined>(undefined);
	const localScreenShareProducer = useRef<Producer<AppData> | undefined>(undefined);
	const localScreenShareAudioProducer = useRef<Producer<AppData> | undefined>(undefined);

	// keepVideoAndScreen preserves the live webcam + screen-share capture tracks
	// (and their store state) across a teardown so they can be republished onto a
	// freshly created transport. WS-reconnect restore uses this so it does not
	// drop an in-progress screen share. The mic is always torn down (the caller
	// re-acquires it), and every producer is closed regardless since its transport
	// is going away.
	const clearLocalStreams = useCallback(
		(opts?: { keepVideoAndScreen?: boolean }) => {
			const keepVideoAndScreen = opts?.keepVideoAndScreen ?? false;

			localAudioStream?.getTracks().forEach((track) => track.stop());
			setLocalAudioStream(undefined);

			if (!keepVideoAndScreen) {
				localVideoStream?.getTracks().forEach((track) => track.stop());
				localScreenShareStream?.getTracks().forEach((track) => track.stop());
				localScreenShareAudioStream?.getTracks().forEach((track) => track.stop());

				setLocalVideoStream(undefined);
				setLocalScreenShare(undefined);
				setLocalScreenShareAudio(undefined);
			}

			localVideoProducer.current?.close();
			localAudioProducer.current?.close();
			localScreenShareProducer.current?.close();
			localScreenShareAudioProducer.current?.close();

			localVideoProducer.current = undefined;
			localAudioProducer.current = undefined;
			localScreenShareProducer.current = undefined;
			localScreenShareAudioProducer.current = undefined;
		},
		[localAudioStream, localScreenShareStream, localVideoStream, localScreenShareAudioStream],
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

		localVideoProducer,
		localAudioProducer,
		localScreenShareProducer,
		localScreenShareAudioProducer,

		clearLocalStreams,
	};
};

export { useLocalStreams };
