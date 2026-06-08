type TEncodeProbeInput = {
	// RTP codec MIME type, e.g. 'video/AV1', 'video/H264', 'video/VP8'.
	mimeType: string;
	width: number;
	height: number;
	framerate: number;
	// Target bitrate in bits per second.
	bitrate: number;
};

type TWebrtcEncodeProbe = {
	// The browser can encode this config at all (hardware OR software encoder).
	supported: boolean;
	// It should be used for real-time: power-efficient (hardware) OR at least
	// smooth at the target frame rate. See the note on `powerEfficient` below.
	capable: boolean;
	// The encode would run on a power-efficient (i.e. hardware) encoder. Surfaced
	// so callers can require hardware specifically and refuse software fallback.
	powerEfficient: boolean;
};

// Probe whether the browser can encode the given video config, via the WebRTC
// Media Capabilities API.
//
// `capable` is true when the encode is power-efficient (hardware) OR reported as
// smooth. Use this for codecs where a real-time software encoder is acceptable.
// Callers that must avoid software fallback should check `powerEfficient`
// directly; on desktop, startup GPU switches enable Chromium's D3D12/WebRTC
// hardware paths before this probe runs.
//
// `supported` is surfaced separately so callers can distinguish "no AV1 encoder
// at all" from "AV1 exists but the probe is unsure".
const probeWebrtcEncode = async ({
	mimeType,
	width,
	height,
	framerate,
	bitrate,
}: TEncodeProbeInput): Promise<TWebrtcEncodeProbe> => {
	const mediaCapabilities = navigator.mediaCapabilities;

	if (!mediaCapabilities?.encodingInfo) {
		return { supported: false, capable: false, powerEfficient: false };
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

		// Note: `smooth` is an instantaneous estimate. A software encoder reported
		// smooth at probe time can still degrade under sustained load (thermal
		// throttling, CPU contention) over a long screen share; `powerEfficient`
		// (hardware) is the more reliable long-term signal.
		return {
			supported: info.supported,
			capable: info.supported && (info.powerEfficient || info.smooth),
			powerEfficient: info.powerEfficient,
		};
	} catch {
		return { supported: false, capable: false, powerEfficient: false };
	}
};

export type { TEncodeProbeInput, TWebrtcEncodeProbe };
export { probeWebrtcEncode };
