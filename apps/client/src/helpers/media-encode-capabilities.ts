import { getDesktopBridge } from '@/runtime/desktop-bridge';
import type { TVideoEncodeCodec } from '@/runtime/types';

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
};

// Probe whether the browser can encode the given video config, via the WebRTC
// Media Capabilities API.
//
// `capable` is true when the encode is power-efficient (hardware) OR reported as
// smooth. The `powerEfficient` flag is unreliable for WebRTC AV1 — Chromium
// frequently reports it false even when a hardware AV1 encoder (e.g. NVENC on
// 40/50-series, Arc, RX 7000) is present — so gating on it alone bounces capable
// hardware to H264. `smooth` is the signal that actually matters for real-time
// (the encoder can sustain the target frame rate), so requiring either keeps the
// software-slideshow guard while no longer rejecting hardware on a bad flag.
//
// `supported` is surfaced separately so callers can distinguish "no AV1 encoder
// at all" from "AV1 exists but the probe is unsure", and only consult the more
// authoritative desktop GPU signal in the latter case.
const probeWebrtcEncode = async ({
	mimeType,
	width,
	height,
	framerate,
	bitrate,
}: TEncodeProbeInput): Promise<TWebrtcEncodeProbe> => {
	const mediaCapabilities = navigator.mediaCapabilities;

	if (!mediaCapabilities?.encodingInfo) {
		return { supported: false, capable: false };
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

		return {
			supported: info.supported,
			capable: info.supported && (info.powerEfficient || info.smooth),
		};
	} catch {
		return { supported: false, capable: false };
	}
};

// Authoritative on the desktop app: consult the GPU's actual hardware
// video-encode profiles (getGPUInfo, exposed over the desktop bridge). Unlike
// the mediaCapabilities `powerEfficient` flag, this reliably reflects per-codec
// hardware encode support. Returns false when not on desktop, the bridge lacks
// the method, the query fails, or no hardware profile for this codec covers the
// resolution — callers then fall back to the WebRTC probe.
const desktopHasHardwareEncode = async (codec: TVideoEncodeCodec, width: number, height: number): Promise<boolean> => {
	const bridge = getDesktopBridge();

	if (!bridge?.getVideoEncodeCapabilities) {
		return false;
	}

	try {
		const capabilities = await bridge.getVideoEncodeCapabilities();

		if (!capabilities.hardwareVideoEncodeEnabled) {
			return false;
		}

		return capabilities.profiles.some((profile) => {
			return profile.codec === codec && profile.maxWidth >= width && profile.maxHeight >= height;
		});
	} catch {
		return false;
	}
};

export type { TEncodeProbeInput, TWebrtcEncodeProbe };
export { desktopHasHardwareEncode, probeWebrtcEncode };
