type TEncodeProbeInput = {
	// RTP codec MIME type, e.g. 'video/AV1', 'video/H264', 'video/VP8'.
	mimeType: string;
	width: number;
	height: number;
	framerate: number;
	// Target bitrate in bits per second.
	bitrate: number;
};

// Probe whether the browser can encode the given video config with a
// power-efficient (hardware) encoder, via the WebRTC Media Capabilities API.
// Returns false when the API is unavailable or the config isn't supported, so
// callers can safely treat "false" as "don't rely on hardware encoding".
const isPowerEfficientWebrtcEncode = async ({
	mimeType,
	width,
	height,
	framerate,
	bitrate,
}: TEncodeProbeInput): Promise<boolean> => {
	const mediaCapabilities = navigator.mediaCapabilities;

	if (!mediaCapabilities?.encodingInfo) {
		return false;
	}

	try {
		const info = await mediaCapabilities.encodingInfo({
			type: 'webrtc',
			video: {
				contentType: mimeType,
				width,
				height,
				framerate,
				bitrate,
			},
		});

		return info.supported && info.powerEfficient;
	} catch {
		return false;
	}
};

export { isPowerEfficientWebrtcEncode };
export type { TEncodeProbeInput };
