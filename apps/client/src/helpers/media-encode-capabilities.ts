type TEncodeProbeInput = {
	// RTP codec MIME type, e.g. 'video/AV1', 'video/H264', 'video/VP8'.
	mimeType: string;
	width: number;
	height: number;
	framerate: number;
	// Target bitrate in bits per second.
	bitrate: number;
};

// Probe whether the browser can encode the given video config acceptably for
// real-time use, via the WebRTC Media Capabilities API.
//
// We accept the encode when it is power-efficient (hardware) OR reported as
// smooth. The `powerEfficient` flag is unreliable for WebRTC AV1 — Chromium
// frequently reports it false even when a hardware AV1 encoder (e.g. NVENC on
// 40/50-series, Arc, RX 7000) is present — so gating on `powerEfficient` alone
// bounces genuinely capable hardware to H264. `smooth` is the signal that
// actually matters for real-time: it means the encoder can sustain the target
// frame rate, which is what prevents a software-encoded slideshow. Requiring
// either keeps the slideshow guard (a non-hardware encoder that can't keep up
// reports both false) while no longer rejecting hardware on a bad flag.
//
// Returns false when the API is unavailable or the config isn't supported, so
// callers can safely treat "false" as "don't rely on this encoder".
const isCapableWebrtcEncode = async ({
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

		return info.supported && (info.powerEfficient || info.smooth);
	} catch {
		return false;
	}
};

export type { TEncodeProbeInput };
export { isCapableWebrtcEncode };
