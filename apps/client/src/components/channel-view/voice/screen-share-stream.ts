/**
 * Combines a screen-share video stream and a screen-share audio stream into a
 * single MediaStream so the browser keeps them on one playback timeline.
 *
 * Falls back to the original video stream when there is no audio stream, or when
 * either side is missing the tracks needed to form a combined stream.
 */
export const buildCombinedScreenShareStream = (
	videoStream: MediaStream | undefined,
	audioStream: MediaStream | undefined,
): MediaStream | undefined => {
	if (!videoStream) return undefined;
	if (!audioStream) return videoStream;

	const videoTracks = videoStream.getVideoTracks();
	const audioTracks = audioStream.getAudioTracks();

	if (videoTracks.length === 0 || audioTracks.length === 0) return videoStream;

	return new MediaStream([...videoTracks, ...audioTracks]);
};
